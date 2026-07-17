# Local search design

Status: the first field-aware phonetic/transliteration ranking slice is deployed
and owner-accepted in protected staging. This design intentionally favors
transparent, deterministic rules over a trained transliteration model. Further
tuning remains evidence-driven.

## Research basis

Informal South Asian romanization has no commonly followed Latin orthography. Writers generally produce approximate phonetic spellings that vary with pronunciation, dialect, transcription habit, and individual preference. The [Dakshina dataset paper](https://aclanthology.org/2020.lrec-1.294/) documents this variation across 12 South Asian languages and provides multiple human-attested romanizations per native word.

Published Hindi, Bangla, and Telugu input-method error analysis identifies ordinary misspellings and systematic phonological ambiguity, especially inconsistent vowel length, aspiration, and Roman letters representing multiple dental/retroflex sounds. See [Challenges in Designing Input Method Editors for Indian Languages](https://aclanthology.org/W11-3501/).

Google's work on [Latin-script keyboards for South Asian languages](https://research.google/pubs/latin-script-keyboards-for-south-asian-languages-with-finite-state-normalization/) reports that transliteration transducers improve accuracy, while compact representations of attested alternatives retain much of that gain under mobile size and latency constraints. Larger learned systems such as [IndicXlit](https://github.com/AI4Bharat/IndicXlit) are useful research references, but their model/runtime cost is disproportionate for this small offline catalog.

The Unicode [transliteration guidelines](https://cldr.unicode.org/index/cldr-spec/transliteration-guidelines) also distinguish reversible formal transliteration from pronunciation-oriented transcription and note context-dependent inherent-vowel behavior. The product therefore should not treat one formal romanization scheme as the way users will type a query.

## Product behavior

- Search remains immediate and entirely local after the normal offline sync.
- An active query orders results by relevance. The selected catalog sort remains the deterministic tie-breaker; with no query, it remains the primary order.
- Exact and literal title/alias matches rank first.
- Phonetic and tightly bounded typo matching applies only to Latin-script titles and aliases.
- Metadata and typed lyrics use literal matching only. Metadata ranks below titles/aliases, and lyric-only results rank last.
- A poor fuzzy comparison does not force a result; the catalog may correctly show no matches.
- Search continues to compose with every accepted filter.

## Matching layers

Each cached catalog row holds separate normalized arrays for titles, aliases, metadata, and typed-lyric blocks. Keeping fields separate prevents a large lyric block from receiving title-level priority.

For titles and aliases, matching proceeds from strongest to weakest:

1. normalized whole-field equality;
2. normalized prefix or substring;
3. bounded, order-preserving token-sequence coverage, allowing a query to begin later or omit intervening title words;
4. conservative local joined/split-word equivalence across contiguous spans of at most three title/alias or query tokens;
5. a compact Indic-roman key for common spelling conventions;
6. bounded Damerau-Levenshtein distance for small insertions, deletions, substitutions, or adjacent transpositions.

Token coverage aligns the complete query against title/alias tokens in order. A normal step matches one query token to one candidate token. A boundary step may instead match one token to two or three contiguous tokens, or two or three query tokens to one candidate token. Candidate words may be skipped, so a query can begin later in a title or omit an intervening word, but candidate tokens cannot be reused and reversed query order does not match.

Joined/split matching requires at least five letters and applies only to titles and aliases. Local boundary steps use exact/prefix or the existing phonetic equivalents without adding typo distance. This lets ordinary matches and a joined/split segment coexist in one query instead of concatenating the whole query. It does not remove spaces globally from titles, metadata, or lyrics, and a boundary cannot span more than three tokens, which limits accidental cross-word matches.

The Indic-roman key currently:

- removes Latin diacritics and ignores case/punctuation;
- treats common long-vowel spellings as equivalent (`a/aa`, `i/ii/ee`, `u/uu/oo`);
- normalizes common sibilant, `v/w`, `q/k`, `ph/f`, and doubled-letter spellings;
- provides a lower-confidence form that ignores an aspiration marker after common stop consonants;
- allows an optional final `a` for longer words;
- retains lower scores for these broader forms so exact spelling still wins.

Query tokens must match distinct candidate tokens. This avoids the AppSheet prototype's behavior where one title token could satisfy several query tokens.

## Typo threshold

Typo tolerance is deliberately length-dependent and limited to titles/aliases:

- fewer than 4 Latin letters: no edit-distance tolerance;
- 4–6 letters: at most one edit;
- 7–11 letters: at most two edits;
- 12 or more letters: at most three edits.

The newly admitted outer tier—the second edit for a 7-letter normalized word or the third edit for a 12+-letter word—is deliberately lower-confidence. It also requires the first normalized phonetic character to agree and permits at most a one-character length difference. Short literal prefixes still work. The length rule prevents one changed character in a very short word from making unrelated titles appear equivalent.

Short tokens still receive no edit-distance tolerance. A query token shorter than three characters may, however, use exact equality of a strong normalized phonetic key of at least two characters. This admits deterministic forms such as a doubled `a` collapsing to `a` without treating arbitrary two-letter words as typo matches.

These thresholds were chosen after aggregate-only evaluation against the local catalog and deterministic boundary-error simulations. A broader rule beginning at 6 letters created substantially more cross-title collisions; the selected boundary produced a small collision increase while recovered full-title simulations remained first in relevance order. They remain starting defaults for real-device review, not permanent language claims.

## Deferred decisions

- Do not add an All/Titles/Lyrics scope control unless real use shows field-aware ranking is insufficient.
- Do not run fuzzy matching over full lyric blocks; it would magnify result noise and per-keystroke work.
- Do not bundle a neural transliteration model until catalog-specific evidence shows that compact rules cannot meet expectations.
- Language-specific confusion tables, attested-alternative dictionaries, or native-script-to-roman derived forms can be added later behind acceptance tests.
- Ranking constants and typo thresholds should change only with concrete false-positive or false-negative examples from staging use.
