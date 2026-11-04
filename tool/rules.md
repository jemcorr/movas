# Rules of a film

`./movas film` reads a cut after it is rendered and states measured facts against stated limits. A flag is a fact, not a verdict. It uses no model.

The rules come from three layers, in one language:

- Craft: `tool/packs/craft.meaning`. Always on. Legibility, reading time, contrast, clipping, sync, loudness, motion.
- Format packs: `tool/packs/<name>.meaning`. A film opts in with `use <name>` in `film/meaning.txt`. `use chat` adds the phone chat.
- Project rules: `film/packs/<name>.meaning` and the lines of `film/meaning.txt`. Product truth belongs here, never in the tool.

A film's own lines win over any pack. A later pack wins over an earlier one. A rule is replaced by declaring its id again, and a limit by declaring its name again. `off <rule>` removes a rule where it stands, in file order: the rule must be declared before the `off` line, and a rule the film declares again after it stays.

`use <name>` looks for `film/packs/<name>.meaning` first, then `tool/packs/<name>.meaning`. A name found in neither is an error.

## Lines

`#` at the start of a line is a comment.

    use <pack>
    limit <name> <number> [note="..."]
    words <name> /regex/flags
    fact <name> <key>=<value> <result>
    rule <id> where <terms> expect|forbid|need <terms> [links] [say="..."] [note="..."]
    alike <id> <terms> vs <terms> [say="..."] [note="..."]
    exempt <rule> where <terms> [say="..."]
    off <rule>
    claims where <terms>
    verb <name> ...

`verb` lines declare a format's verbs and their required keys. They belong to a format pack in `tool/packs`, and anywhere else they are an error.

`expect` tests the selected line. `forbid` fires when another line matches. `need` fires when no other line matches. `alike` fires when two groups of lines cannot be told apart by side and fill. `claims where` picks the lines that the report's ledger lists as claims. With no such line, it lists every line with no `in=` that is not credits.

Terms, all of which must hold: `key=a|b`, `key!=a|b`, `key>=n`, `key<=n`, `key~/re/flags`, `key!~/re/flags`.

Links, on `forbid` and `need`:

- `same=panel,scene,speaker,text`: the other line shares these.
- `before=at|first|last`: the other line starts at or before this moment of the selected line.
- `after=at|first|last`: the other line starts at or after it.
- `during`: the other line starts while the selected line is on screen.
- `grace=<n>s`: the other line must clear the moment by this much.
- `within=<n>s`: the other line must be within this much of the moment. It needs `before=` or `after=`.

A link anywhere else is an error, and so is a term that reads as a link but has another name, such as `near=3s`. So a typo never turns into a fact that no line has.

`say="..."` may name a limit: `{cover.frames}` prints its value, and `{cover.share%}` prints it as a percent. A film that changes the limit gets the right words.

## Facts

- Every line: `verb id scene text words panel speaker at first last seen full need read_ratio clip_frames`.
- What was drawn: `drawn.align family fill ink inkFamily contrast px text boxed inPanel`.
- A count: `count.<list>` is how many different hits of a `words` line the line's declared text has.
- A declared meaning: a `fact` name. `fact role side=out sent` makes `role=sent` true on a line with `side=out`.
- Any other bare key reads the line's own key=value in the score.
- One row per scene, `verb=scene`: `words_cut jitter_elements spikes group_snap flow_jitter`.
- One row for the film, `verb=film`: `clip_samples silence_s cue_lag_frames bed_off_ms`.

`drawn.boxed` is 1 when the text sits on its own filled box no larger than 6 times the text's area, and 0 otherwise. `drawn.inPanel` is true when the text is drawn inside a panel.

`drawn.text~/re/` reads the words a line shows over time. When it selects a line, `first` and `last` are the moments those words hold. That is how a rule reads a label at a moment.

The panel of a line is `in=`, then `on=`, then the scene's only panel, then the panel whose drawn box holds the line.

## A rule refuses rather than passes

Every selected line ends as pass, miss or cannot-check. A fact the film cannot give is a refusal, printed under `## Cannot check`. Examples: a line the display list does not draw, a pass on a scene with GL content, a sound rule with no encoded file, a panel link when no single box holds the line, a value no `fact` line maps. A term on an absent key is false, and `!=` on it is true.

## Example: a debt reminder

    # film/packs/debt-reminder.meaning
    rule paid.received where verb=tag drawn.text~/^paid$/i need verb=text text~/payment received/i same=panel before=first say="An account reads Paid before its own payment line"
    rule paid.owes where verb=tag drawn.text~/^paid$/i forbid verb=text text~/still owes/i same=panel before=last say="An account reads Paid while its own card says the person still owes"

    # film/meaning.txt
    use debt-reminder

`fixtures/debt/film` is that film. A word ban that fails the compile lives in `film/rules.movas`: `rule tone.threat words=lawsuit,police scope=verb:text say="a reminder may not threaten" owner=you why="..."`.

A bad line stops `./movas check` and `./movas film` with its file and line number. `./movas check` prints it as `error meaning` and exits 1. `./movas film` exits 2. An `off`, an `exempt` or a `count.`/`drawn.` term that names nothing declared is a bad line too.
