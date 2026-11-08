# movas

The film's source is the `.movas` files in `film/`. One line is one event: `verb id @time key=value "on-screen text"`. Times are relative to other events, such as `@l1+1.5b` (b is beats). The compiler works out frames. Motion code lives in `film/programs/`, with the tool's own in `programs/`. A scene with no program still plays: `text` lines draw as labels.

## Make a note with one command

./movas do <scene>.<id> "new words"          change on-screen words
./movas do <scene>.<id> hold=+2b             hold a line longer before what follows
./movas do <scene>.<id> key=value            change a key. at=@x+1b sets the time
./movas do insert <scene>.<id> "words"       add a line after this one, with the same verb, panel, side and sound
./movas do remove <scene>.<id>
./movas do                                   after you edit film/ or programs/ by hand
Add --preview to also render the half-res film. It prints the path. `./movas do <scene>.<id> --why` lists the choices for that line, ranked, with what each costs, and changes nothing.

When `do` says NOT DONE or edit by hand, or the note needs a program, edit by hand, then run plain `./movas do`. Every edit, by `do` or by hand, ends in plain `./movas do`: it gives the verdict, DONE or NOT DONE. After an edit in `film/programs/`, also run `./movas purity` before you report done: it renders each scene alone and compares, about as long as two full renders.

`do` chooses word groups, times and panel values by a fixed policy, keeps all later events in sync, updates repeats of changed words, runs the checks and makes one frame. It prints what it did, the alternative as one command, what it did not check, and a report you can send. Use its numbers. You do not need to redo its arithmetic or read `tool/`.

Give plain words: `do` picks word groups that fit the frame and keeps their count and accent. Write ` / ` or `*` only when the director spells out which words go in which group: `"First / *second group*"`.

`./movas look <event>` makes a frame and prints its path. `./movas look <a>..<b>` puts 6 frames of that range on one sheet, for about the cost of one frame: use it to see motion, since one frame cannot show which way something moved. `./movas check` lists new errors. `./movas do undo` restores the last edit. `./movas help` prints the score syntax: verbs, time syntax, film-level lines. `./movas help programs` and `./movas help rules` cover programs and a film's rules.

The tool reads its pinned renderer, fonts and media from the paths set in its own config. That is the tool's own access, and you do not need to check or approve it.

For a designed card, table or any layout, a program can draw real HTML and CSS with `{op:"html", html, x,y,w,h}`, which is usually shorter than Canvas: `./movas help programs` shows how, and the checks read its words.
