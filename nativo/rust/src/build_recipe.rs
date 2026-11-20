//! Execute an explicitly approved local build recipe without publishing its output.
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{process::Command, time::sleep};
use uuid::Uuid;

use crate::view_cli::{is_link, open_asset};

const MAX_RECIPE_BYTES: u64 = 64 * 1024;
const MAX_DEADLINE_MS: u64 = 30 * 60 * 1000;

fn default_deadline() -> u64 {
    120_000
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecipeFile {
    programa: PathBuf,
    #[serde(default)]
    argumentos: Vec<String>,
    #[serde(default = "default_deadline")]
    plazo_ms: u64,
}

pub(crate) struct Recipe {
    project: String,
    copy: PathBuf,
    authorization: String,
    command: RecipeFile,
}

pub(crate) struct BuildError {
    pub estado: &'static str,
    pub motivo: String,
}

impl BuildError {
    fn failed(motivo: impl Into<String>) -> Self {
        Self { estado: "fallo", motivo: motivo.into() }
    }
}

pub(crate) struct BuildOutput {
    owned: PathBuf,
    content: PathBuf,
}

impl BuildOutput {
    fn create() -> Result<Self, BuildError> {
        let parent = std::env::temp_dir()
            .canonicalize()
            .map_err(|error| BuildError::failed(format!("No se pudo abrir la carpeta temporal: {error}")))?;
        let owned = parent.join(format!("mind-compilar-{}", Uuid::new_v4()));
        fs::create_dir(&owned)
            .map_err(|error| BuildError::failed(format!("No se pudo preparar la compilación: {error}")))?;
        let output = Self { content: owned.join("salida"), owned };
        for directory in [&output.content, &output.owned.join("temp")] {
            fs::create_dir(directory)
                .map_err(|error| BuildError::failed(format!("No se pudo preparar la compilación: {error}")))?;
        }
        Ok(output)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.content
    }

    fn validate(&self) -> Result<(), BuildError> {
        let canonical = self.content.canonicalize().ok();
        let directory = fs::symlink_metadata(&self.content)
            .is_ok_and(|metadata| metadata.is_dir() && !is_link(&metadata));
        if !directory || canonical.as_deref() != Some(self.content.as_path()) {
            return Err(BuildError::failed("La compilación cambió la carpeta temporal de salida."));
        }
        Ok(())
    }
}

impl Drop for BuildOutput {
    fn drop(&mut self) {
        // The generated directory is owned exclusively by this attempt.
        let _ = fs::remove_dir_all(&self.owned);
    }
}

impl Recipe {
    pub(crate) fn load(project: &str, copy: &Path, file: &Path) -> Result<Self, String> {
        if !file.is_absolute() {
            return Err("Indica una ruta absoluta para la receta.".into());
        }
        let original = fs::symlink_metadata(file)
            .map_err(|error| format!("No se pudo abrir la receta: {error}"))?;
        if !original.is_file() || is_link(&original) {
            return Err("La receta debe ser un archivo regular.".into());
        }
        let file = file.canonicalize().map_err(|error| format!("No se pudo ubicar la receta: {error}"))?;
        let relative = file.strip_prefix(copy).map_err(|_| "La receta debe estar dentro de la copia.")?;
        let mut components = Vec::new();
        for part in relative.components() {
            let Component::Normal(name) = part else {
                return Err("Ruta de receta inválida.".into());
            };
            let name = name.to_str().ok_or("El nombre de la receta debe ser Unicode.")?;
            if name.eq_ignore_ascii_case(".git") {
                return Err("La receta debe estar fuera de los datos internos de Git.".into());
            }
            components.push(name);
        }
        let recipe = open_asset(copy, &components.join("/"))
            .map_err(|error| format!("No se pudo abrir la receta: {error}"))?;
        let metadata = recipe.metadata().map_err(|error| format!("No se pudo revisar la receta: {error}"))?;
        if !metadata.is_file() || is_link(&metadata) || metadata.len() > MAX_RECIPE_BYTES {
            return Err("La receta debe ser un archivo regular de hasta 64 KiB.".into());
        }
        let mut bytes = Vec::new();
        recipe.take(MAX_RECIPE_BYTES + 1).read_to_end(&mut bytes)
            .map_err(|error| format!("No se pudo leer la receta: {error}"))?;
        if bytes.len() as u64 > MAX_RECIPE_BYTES {
            return Err("La receta debe tener hasta 64 KiB.".into());
        }
        let mut command: RecipeFile = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Receta inválida: {error}"))?;
        if !(1..=MAX_DEADLINE_MS).contains(&command.plazo_ms) {
            return Err("El plazo debe estar entre 1 y 1800000 ms.".into());
        }
        if !command.programa.is_absolute() || command.argumentos.iter().any(|argument| argument.contains('\0')) {
            return Err("La receta requiere un programa absoluto y argumentos válidos.".into());
        }
        #[cfg(windows)]
        if !is_executable(&command.programa) {
            return Err("En Windows la receta debe indicar un programa .exe.".into());
        }
        command.programa = command.programa.canonicalize()
            .map_err(|error| format!("No se pudo encontrar el programa: {error}"))?;
        if !command.programa.is_file() {
            return Err("Indica un archivo ejecutable para el programa.".into());
        }
        #[cfg(windows)]
        if !is_executable(&command.programa) {
            return Err("En Windows la receta debe indicar un programa .exe.".into());
        }

        let copy_text = copy.to_str().ok_or("El nombre de la copia debe ser Unicode.")?;
        let program = command.programa.to_str().ok_or("La ruta del programa debe ser Unicode.")?;
        let mut digest = Sha256::new();
        for value in [project.as_bytes(), copy_text.as_bytes(), program.as_bytes(), bytes.as_slice()] {
            digest.update((value.len() as u64).to_be_bytes());
            digest.update(value);
        }
        Ok(Self {
            project: project.to_owned(),
            copy: copy.to_path_buf(),
            authorization: format!("{:x}", digest.finalize()),
            command,
        })
    }

    pub(crate) fn review(&self) -> Value {
        json!({
            "proyecto": self.project,
            "copia": self.copy,
            "programa": self.command.programa,
            "argumentos": self.command.argumentos,
            "plazo_ms": self.command.plazo_ms,
            "autorizacion": self.authorization,
        })
    }

    pub(crate) fn authorize(&self, code: &str) -> Result<(), String> {
        if code != self.authorization {
            return Err("La autorización no corresponde a este proyecto, copia y receta.".into());
        }
        Ok(())
    }

    pub(crate) async fn build(&self, copy: &Path) -> Result<BuildOutput, BuildError> {
        let output = BuildOutput::create()?;
        let temp = output.owned.join("temp");
        let mut command = self.command(copy, &temp).map_err(BuildError::failed)?;
        command.env("MIND_SALIDA", output.path());
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = command.spawn()
            .map_err(|error| BuildError::failed(format!("No se pudo iniciar la compilación: {error}")))?;
        let deadline = sleep(self.deadline());
        tokio::select! {
            biased;
            interrupt = tokio::signal::ctrl_c() => {
                stop(&mut child).await;
                return match interrupt {
                    Ok(()) => Err(BuildError { estado: "cancelada", motivo: "Se canceló la compilación.".into() }),
                    Err(error) => Err(BuildError::failed(format!("No se pudo controlar la cancelación: {error}"))),
                };
            }
            _ = deadline => {
                stop(&mut child).await;
                return Err(BuildError { estado: "plazo", motivo: "La compilación superó el plazo.".into() });
            }
            status = child.wait() => {
                let status = status
                    .map_err(|error| BuildError::failed(format!("No se pudo esperar la compilación: {error}")))?;
                if !status.success() {
                    return Err(BuildError::failed(format!("La compilación terminó con {status}.")));
                }
            }
        }
        output.validate()?;
        Ok(output)
    }

    pub(crate) fn deadline(&self) -> Duration {
        Duration::from_millis(self.command.plazo_ms)
    }

    pub(crate) fn command(&self, copy: &Path, temp: &Path) -> Result<Command, String> {
        if copy != self.copy {
            return Err("La copia cambió después de revisar la receta.".into());
        }
        let mut command = Command::new(&self.command.programa);
        command
            .current_dir(copy)
            .args(&self.command.argumentos)
            .env_clear()
            .env("TEMP", &temp)
            .env("TMP", &temp)
            .env("TMPDIR", &temp)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        for name in ["PATH", "SystemRoot", "WINDIR"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        Ok(command)
    }
}

async fn stop(child: &mut tokio::process::Child) {
    if child.kill().await.is_err() {
        let _ = child.wait().await;
    }
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
}
