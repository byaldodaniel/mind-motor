use std::{
    cell::RefCell,
    fs,
    path::{Component, Path},
};

use crate::{motor_native::Fault, scan};

#[derive(Clone)]
pub(crate) struct Workspace {
    pub(crate) active: bool,
    pub(crate) roots: Vec<String>,
    pub(crate) user_data: Option<String>,
}

pub(crate) fn relative_parts<'a>(parent: &Path, child: &'a Path) -> Option<Vec<&'a str>> {
    let mut child = child.components();
    for expected in parent.components() {
        let actual = child.next()?;
        let (expected, actual) = (expected.as_os_str().to_str()?, actual.as_os_str().to_str()?);
        let equal = if cfg!(windows) {
            expected.to_lowercase() == actual.to_lowercase()
        } else {
            expected == actual
        };
        if !equal {
            return None;
        }
    }
    child.map(|part| {
        let Component::Normal(part) = part else { return None };
        part.to_str()
    }).collect()
}

pub(crate) fn same_path(left: &str, right: &Path) -> bool {
    relative_parts(Path::new(left), right).is_some_and(|parts| parts.is_empty())
}

fn contains(parent: &str, child: &str) -> bool {
    relative_parts(Path::new(parent), Path::new(child)).is_some()
}

fn overlaps(left: &str, right: &str) -> bool {
    contains(left, right) || contains(right, left)
}

pub(crate) fn physical_directory(path: &Path) -> Option<String> {
    if !path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir)) {
        return None;
    }
    let canonical = fs::canonicalize(path).ok()?;
    if !canonical.is_dir() {
        return None;
    }
    let value = canonical.to_str()?;
    #[cfg(windows)]
    let value = value.strip_prefix(r"\\?\").unwrap_or(value);
    Some(value.to_owned())
}

fn ignored(path: &Path) -> bool {
    let mut previous = String::new();
    for component in path.components() {
        let Component::Normal(name) = component else { continue };
        let name = name.to_string_lossy().to_lowercase();
        if matches!(name.as_str(), ".codex" | ".claude" | ".gemini" | ".git" | ".papelera-mind" | "node_modules")
            || (previous == "documents" && name == "codex")
        {
            return true;
        }
        previous = name;
    }
    false
}

impl Workspace {
    pub(crate) fn open(
        base: &str,
        motor_directory: Option<&Path>,
        installation: Option<&Path>,
        user_data: Option<&Path>,
        paths: &[String],
        active: bool,
    ) -> Result<Self, Fault> {
        if paths.len() > 64 {
            return Err(Fault {
                code: "INVALID_WORKSPACE",
                message: "El cliente comunicó demasiadas carpetas abiertas.".into(),
            });
        }
        let base = physical_directory(Path::new(base)).unwrap_or_else(|| base.to_owned());
        let motor = motor_directory.and_then(physical_directory);
        let installation = installation.and_then(physical_directory);
        let user_data = user_data.and_then(physical_directory).filter(|data| {
            installation.as_ref().is_some_and(|root| {
                same_path(data, &Path::new(root).join("Conversaciones"))
            })
        });
        let home = std::env::home_dir().and_then(|home| physical_directory(&home));

        let permitted = |root: &str| {
            let outside_protected = !overlaps(&base, root)
                && motor.as_ref().is_none_or(|motor| !overlaps(motor, root))
                && installation.as_ref().is_none_or(|installation| {
                    !overlaps(installation, root)
                        || user_data.as_ref().is_some_and(|data| {
                            contains(installation, data) && contains(data, root)
                        })
                });
            Path::new(root).parent().is_some()
                && home.as_ref().is_none_or(|home| !contains(root, home))
                && outside_protected
                && !ignored(Path::new(root))
                && scan::open_directory(root, "").is_ok()
        };
        let mut roots = Vec::new();
        let mut add = |root: String| {
            if !roots.iter().any(|known: &String| same_path(known, Path::new(&root))) {
                roots.push(root);
            }
        };
        for candidate in paths {
            let candidate = Path::new(candidate);
            if ignored(candidate) {
                continue;
            }
            let Some(mut root) = physical_directory(candidate) else { continue };
            if installation.as_ref().is_some_and(|install| same_path(install, Path::new(&root))) {
                let Some(data) = &user_data else { continue };
                root.clone_from(data);
            }
            if permitted(&root) {
                add(root);
            }
        }
        let user_data = user_data.as_ref().filter(|data| permitted(data)).cloned();
        let user_data = if !active || !roots.is_empty() { user_data } else { None };
        if let Some(data) = &user_data {
            if !roots.iter().any(|root| same_path(root, Path::new(data))) {
                roots.push(data.clone());
            }
        }
        Ok(Self { active, roots, user_data })
    }

    pub(crate) fn has_roots(&self) -> bool {
        !self.roots.is_empty()
    }

    pub(crate) fn grants(&self, path: &str) -> bool {
        self.roots.iter().any(|root| same_path(root, Path::new(path)))
    }
}

thread_local! {
    static CURRENT: RefCell<Option<Workspace>> = const { RefCell::new(None) };
}

pub(crate) fn current_workspace() -> Option<Workspace> {
    CURRENT.with(|current| current.borrow().clone())
}

pub(crate) fn with_workspace<T>(workspace: &Workspace, operation: impl FnOnce() -> T) -> T {
    struct Restore(Option<Workspace>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CURRENT.with(|current| current.replace(self.0.take()));
        }
    }
    let _restore = Restore(CURRENT.with(|current| current.replace(Some(workspace.clone()))));
    operation()
}
