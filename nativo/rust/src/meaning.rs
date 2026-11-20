//! Búsqueda local experimental sobre resúmenes ya autorizados.
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    io::{self, Read},
};

use serde::{Deserialize, Serialize};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

const MAX_INPUT: u64 = 16 * 1024 * 1024;
const MAX_DOCUMENTS: usize = 2048;
const MAX_SPANS: usize = 48_000;
const MAX_EXCERPT: usize = 480;
const MAX_QUERY_TERMS: usize = 24;
const NEIGHBORS_PER_TERM: usize = 3;
const MIN_SUPPORT: usize = 2;
const MIN_ASSOCIATION: f64 = 0.5;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    id: String,
    important: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    query: String,
    documents: Vec<Document>,
    limit: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Intent {
    Decision,
    Idea,
}

#[derive(Clone, Copy)]
enum IntentMatch {
    Untyped,
    Known(Intent),
    Unclear,
}

struct Passage<'a> {
    id: &'a str,
    excerpt: &'a str,
    intent: IntentMatch,
    terms: HashSet<String>,
}

#[derive(Serialize)]
struct Found<'a> {
    id: &'a str,
    excerpt: &'a str,
}

#[derive(Serialize)]
struct Output<'a> {
    total: usize,
    matches: Vec<Found<'a>>,
}

fn words(text: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut word = String::new();
    for ch in text.nfd().filter(|ch| !is_combining_mark(*ch)).flat_map(char::to_lowercase) {
        if ch.is_alphanumeric() {
            // Long tokens are not suitable for expansion; exact codes use FTS.
            if word.len() <= 48 {
                word.push(ch);
            }
        } else if !word.is_empty() {
            if word.len() <= 48 {
                result.push(std::mem::take(&mut word));
            }
            word.clear();
        }
    }
    if !word.is_empty() && word.len() <= 48 {
        result.push(word);
    }
    result
}

fn marker(word: &str) -> Option<Intent> {
    match word {
        "decision" | "decisiones" | "acuerdo" | "acuerdos" | "acordado" | "acordada"
        | "acordar" | "acordamos" | "acordo" | "aprobar" | "aprobo" | "aprobado"
        | "aprobada" | "aprobados" | "aprobadas" | "aprobamos" | "aprobaron"
        | "aprobacion" | "decidir" | "decidimos" | "decidio" | "autorizado"
        | "autorizada" | "autorizamos" | "resolucion" | "resolvimos" => Some(Intent::Decision),
        "idea" | "ideas" | "propuesta" | "propuestas" | "proponer" | "propusimos"
        | "propuso" | "sugerencia" | "sugerencias" | "sugerimos" | "sugirio"
        | "hipotesis" | "borrador" | "borradores" => Some(Intent::Idea),
        _ => None,
    }
}

fn negates(tokens: &[String], index: usize) -> bool {
    tokens[index.saturating_sub(3)..index]
        .iter()
        .any(|word| matches!(word.as_str(), "no" | "nunca" | "jamas" | "sin"))
}

fn intent(tokens: &[String]) -> IntentMatch {
    let mut found = None;
    for (index, word) in tokens.iter().enumerate() {
        let Some(kind) = marker(word) else { continue };
        if negates(tokens, index) || found.is_some_and(|previous| previous != kind) {
            return IntentMatch::Unclear;
        }
        found = Some(kind);
    }
    found.map_or(IntentMatch::Untyped, IntentMatch::Known)
}

fn passage_intent(text: &str, tokens: &[String], section: IntentMatch) -> IntentMatch {
    if tokens
        .iter()
        .enumerate()
        .any(|(index, word)| marker(word).is_some() && negates(tokens, index))
    {
        return IntentMatch::Unclear;
    }
    if let Some((label, _)) = text.split_once(':') {
        let label = words(label);
        if label.len() == 1 {
            if let Some(kind) = marker(&label[0]) {
                return IntentMatch::Known(kind);
            }
        }
    }
    match intent(tokens) {
        IntentMatch::Untyped => section,
        explicit => explicit,
    }
}

fn topic(word: &str) -> bool {
    (word.chars().count() >= 2 || word.bytes().all(|byte| byte.is_ascii_digit()))
        && marker(word).is_none()
        && !matches!(word,
            "al" | "algo" | "algun" | "alguna" | "algunos" | "algunas" | "ante" | "asi"
            | "cada" | "como" | "con" | "cual" | "cuales" | "cuando" | "cuanto" | "cuantos"
            | "cuanta" | "cuantas" | "cuyo" | "de" | "del" | "desde" | "dime" | "donde"
            | "dos" | "el" | "ella" | "ellas" | "ellos" | "en" | "entre" | "era" | "es"
            | "esa" | "esas" | "ese" | "eso" | "esta" | "estan" | "este" | "esto"
            | "fue" | "ha" | "hasta" | "hay" | "la" | "las" | "le" | "les" | "lo"
            | "los" | "mas" | "me" | "mi" | "mis" | "muy" | "ni" | "no" | "nos"
            | "nuestra" | "nuestro" | "otra" | "otro" | "para" | "pero" | "por"
            | "podemos" | "puedo" | "puede" | "que" | "quien" | "quienes" | "se"
            | "segun" | "sera" | "si" | "sin" | "sobre" | "son" | "su" | "sus"
            | "tambien" | "te" | "tiene" | "tienen" | "todo" | "tu" | "un" | "una"
            | "uno" | "unos" | "unas" | "va" | "vamos" | "ya")
}

fn fold_plural(word: &str) -> &str {
    if let Some(stem) = word.strip_suffix("es") {
        if stem.chars().count() >= 3
            && stem.chars().last().is_some_and(|ch| matches!(ch, 'd' | 'l' | 'n' | 'r' | 'z'))
        {
            return stem;
        }
    }
    if let Some(stem) = word.strip_suffix('s') {
        if stem.chars().count() >= 3
            && stem.chars().last().is_some_and(|ch| matches!(ch, 'a' | 'e' | 'i' | 'o' | 'u'))
        {
            return stem;
        }
    }
    word
}

fn heading(text: &str) -> Option<(usize, IntentMatch)> {
    let depth = text.bytes().take_while(|byte| *byte == b'#').count();
    if !(1..=6).contains(&depth) || !text[depth..].starts_with(char::is_whitespace) {
        return None;
    }
    Some((depth, intent(&words(&text[depth..]))))
}

fn sentences(text: &str) -> impl Iterator<Item = &str> {
    // Keep separators inside identifiers and URLs unless followed by whitespace.
    let mut rest = text.trim();
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let split = rest.char_indices().find_map(|(index, ch)| {
            let end = index + ch.len_utf8();
            (matches!(ch, '.' | ';' | '!' | '?') && rest[end..].starts_with(char::is_whitespace))
                .then_some(end)
        });
        let (piece, tail) = rest.split_at(split.unwrap_or(rest.len()));
        rest = tail.trim_start();
        Some(piece)
    })
}

fn bounded(text: &str) -> impl Iterator<Item = &str> {
    let mut rest = text.trim();
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let mut units = 0;
        let mut end = rest.len();
        let mut boundary = None;
        for (index, ch) in rest.char_indices() {
            units += ch.len_utf16();
            if units > MAX_EXCERPT {
                end = boundary.unwrap_or(index);
                break;
            }
            if ch.is_whitespace() {
                boundary = Some(index);
            }
        }
        let (piece, tail) = rest.split_at(end);
        rest = tail.trim_start();
        Some(piece.trim_end())
    })
}

fn passages(documents: &[Document]) -> Result<Vec<Passage<'_>>, String> {
    let mut all = Vec::new();
    for document in documents {
        let mut sections = Vec::new();
        for line in document.important.lines().map(str::trim).filter(|line| !line.is_empty()) {
            if let Some((depth, kind)) = heading(line) {
                while sections.last().is_some_and(|&(level, _)| level >= depth) {
                    sections.pop();
                }
                sections.push((depth, kind));
                continue;
            }
            let inherited = sections
                .iter().rev().map(|&(_, kind)| kind)
                .find(|kind| !matches!(kind, IntentMatch::Untyped))
                .unwrap_or(IntentMatch::Untyped);
            for excerpt in sentences(line).flat_map(bounded) {
                let tokens = words(excerpt);
                let terms = tokens.iter().map(String::as_str).filter(|word| topic(word))
                    .map(fold_plural).map(str::to_owned).collect::<HashSet<_>>();
                if terms.is_empty() {
                    continue;
                }
                if all.len() == MAX_SPANS {
                    return Err("El conjunto supera el límite de pasajes de la búsqueda de prueba.".into());
                }
                all.push(Passage {
                    id: &document.id,
                    excerpt,
                    intent: passage_intent(excerpt, &tokens, inherited),
                    terms,
                });
            }
        }
    }
    Ok(all)
}

struct QueryTerm<'a> {
    exact: String,
    rarity: f64,
    neighbors: Vec<(&'a str, f64)>,
}

fn candidates<'a>(tokens: Vec<String>, corpus: &'a [Passage]) -> Vec<QueryTerm<'a>> {
    let mut frequency = HashMap::new();
    for passage in corpus {
        for token in &passage.terms {
            *frequency.entry(token.as_str()).or_insert(0_usize) += 1;
        }
    }
    tokens.into_iter().map(|exact| {
        let exact_count = frequency.get(exact.as_str()).copied().unwrap_or_default();
        let rarity = 1.0 + ((1 + corpus.len()) as f64 / (1 + exact_count) as f64).ln();
        let mut together = HashMap::new();
        if exact_count >= MIN_SUPPORT {
            for passage in corpus.iter().filter(|passage| passage.terms.contains(&exact)) {
                for term in passage.terms.iter().filter(|term| term.as_str() != exact.as_str()) {
                    *together.entry(term.as_str()).or_insert(0_usize) += 1;
                }
            }
        }
        let mut neighbors: Vec<_> = together.into_iter().filter_map(|(term, support)| {
            let denominator = exact_count.max(frequency[term]);
            let association = support as f64 / denominator as f64;
            (support >= MIN_SUPPORT && association >= MIN_ASSOCIATION).then_some((term, association))
        }).collect();
        neighbors.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        neighbors.truncate(NEIGHBORS_PER_TERM);
        QueryTerm { exact, rarity, neighbors }
    }).collect()
}

fn relevance(passage: &Passage, query: &[QueryTerm], wanted: IntentMatch) -> Option<f64> {
    if let IntentMatch::Known(wanted) = wanted {
        if !matches!(passage.intent, IntentMatch::Known(found) if found == wanted) {
            return None;
        }
    }
    let mut used = HashSet::new();
    let mut score = 0.0;
    for term in query {
        if passage.terms.contains(&term.exact) {
            used.insert(term.exact.as_str());
            score += term.rarity;
        }
    }
    let direct = used.len();
    for term in query.iter().filter(|term| !passage.terms.contains(&term.exact)) {
        let minimum = if query.len() == 1 {
            if matches!(wanted, IntentMatch::Known(_)) { MIN_ASSOCIATION } else { 0.80 }
        } else {
            MIN_ASSOCIATION
        };
        if let Some(&(neighbor, strength)) = term.neighbors.iter().find(|&&(neighbor, strength)| {
            strength >= minimum && passage.terms.contains(neighbor) && !used.contains(neighbor)
        }) {
            used.insert(neighbor);
            score += term.rarity * strength * 0.65;
        }
    }
    let required = if query.len() == 1 { 1 } else { (query.len() * 2).div_ceil(3).max(2) };
    let evidence = used.len() >= required
        && (query.len() == 1 || direct > 0 || matches!(wanted, IntentMatch::Known(_)));
    evidence.then_some(score)
}

fn search(input: &Input) -> Result<Output<'_>, String> {
    let tokens = words(&input.query);
    let wanted = intent(&tokens);
    let query: BTreeSet<_> = tokens.iter().map(String::as_str).filter(|word| topic(word))
        .map(fold_plural).map(str::to_owned).collect();
    if query.is_empty() || matches!(wanted, IntentMatch::Unclear) || query.len() > MAX_QUERY_TERMS {
        return Ok(Output { total: 0, matches: Vec::new() });
    }
    let corpus = passages(&input.documents)?;
    let query = candidates(query.into_iter().collect(), &corpus);
    let mut best: HashMap<&str, (f64, &str)> = HashMap::new();
    for passage in &corpus {
        let Some(score) = relevance(passage, &query, wanted) else { continue };
        let entry = best.entry(passage.id).or_insert((score, passage.excerpt));
        if score > entry.0 {
            *entry = (score, passage.excerpt);
        }
    }
    let mut ranked: Vec<_> = best.into_iter().collect();
    ranked.sort_by(|a, b| b.1.0.total_cmp(&a.1.0).then_with(|| a.0.cmp(b.0)));
    let total = ranked.len();
    let matches = ranked.into_iter().take(input.limit as usize)
        .map(|(id, (_, excerpt))| Found { id, excerpt }).collect();
    Ok(Output { total, matches })
}

pub(crate) fn run() -> Result<(), String> {
    let mut bytes = Vec::new();
    io::stdin().lock().take(MAX_INPUT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_INPUT {
        return Err("La búsqueda supera el límite de 16 MiB.".into());
    }
    let input: Input = serde_json::from_slice(&bytes).map_err(|_| "Solicitud de búsqueda inválida.")?;
    let mut ids = HashSet::new();
    if input.query.is_empty() || input.query.len() > 1024 || input.query.contains('\0')
        || !(1..=100).contains(&input.limit) || input.documents.len() > MAX_DOCUMENTS
        || input.documents.iter().any(|document| document.id.is_empty() || document.id.len() > 128
            || document.id.contains('\0') || document.important.len() > 64 * 1024
            || !ids.insert(document.id.as_str()))
    {
        return Err("Solicitud de búsqueda fuera de los límites de prueba.".into());
    }
    let result = search(&input)?;
    serde_json::to_writer(io::stdout().lock(), &result).map_err(|e| e.to_string())
}
