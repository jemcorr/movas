# movas in one page

The film's source is the `.movas` files in `film/`. One line is one event. You never write a frame number, a timestamp or a derived value: the compiler solves those. Run `./movas check` after every edit. It fails on broken references, missing sound files, reading floors, and the rules in `film/rules.movas`. Rules are per film, so a blank film starts with no rules on words or digits.

Line: `verb id @time key=value "on-screen text"`. A `#` at line start or after a space starts a comment.

Time: `@cause+offset~snap`. Offset units `b` beats, `bar`, `s`, `f` frames. `~kick` or `~0.25b` snaps forward to that grid. `@max(a,b)` takes the later one. Causes are event ids: `p` in this scene, `s06.end` or any event of another scene by its id, `start`, `end`. The end of a scene is `<scene>.end`. A scene that declares an `out` cue also has `<scene>.out`.

Verbs:
- `punch p @t step=0.5b size= top= accent= hits=file:vol,... "Group one / *group two*"`. Word groups split on `/`. `*x*` is the accent. Generates `p.g1..n`, `p.floor` (reading floor) and `p.out`. `out=@x` holds it until x. `with=l1` shares a floor with l1.
- `dock d @t size= left= top= accent= out=@x resume=@y "line\nline"`. Generates `d.on`, `d.docked`, `d.undock`, `d.out`.
- `text`, `tag`, `typed`, `credits`, `panel`, `mark` place other text. A format adds verbs: a film with `use chat` in `film/meaning.txt` has `msg` and `chat`.
- `cue id @t key=value` is any named moment a program reads. `end @t` ends the scene.
- `sfx file @t vol=`, or `sfx=file:vol[+-offset],...` attached to any line. `hits=` gives one sound per word group. `pulse @t n= every= files= vol=` makes a run of sounds.
- `vo id @t file=vo/a.wav gain=1 "spoken words"` plays speech. `clip id @t file=clips/x.mp4 in=2 dur=5s` shows video. Their length comes from the file, so `@id.out` is when it ends and a line with no time follows the one before it. Run `./movas probe` after adding a file. `duck bed gain=0.3 on=vo` lowers the music under speech.
- `var name "value"` at film level and `${name}` anywhere make variants. `MOVAS_SET='{"name":"x"}' ./movas render` overrides it.
- `flash=color:peak:lenf` on any line. `assert id on=kick` fails the build if an event leaves the kick.

Scene header: `scene s09 "Title" program=stage pre= post=`. `pre` and `post` are frames of overlap drawn outside the scene.

Reading floors come from the word count and the rule in `film/rules.movas`. A longer sentence makes `p.floor` and `p.out` later, and everything after them follows by itself. Do not compensate by hand.

Do not work out frames, beats or reading times in your head, and do not read `tool/` to learn how they are computed. Make the edit, run `./movas check`, and read what it says moved. It takes about 30 ms and you can undo with another edit. Trying is cheaper than predicting.

Before you reason about beats, a hold, or a panel's size, run `./movas options s09.l2` on the line. It lists the choices with what each one costs. Pick one with `--take=`. If the note leaves the choice open, take the first row that obeys the note, and name the alternative in your report.

`film/` is the only place that holds copy, times and sound. No other file repeats them, so there is nothing else to update and nothing to grep for.

Music: a bar is 4 beats and the kick is its first beat. A move of whole bars keeps every event's place in the bar. `./movas check` lists what left the kick. When a longer line pushes later events off the kick there are two honest ways out: take the time from inside the scene (start the line earlier, or shrink a gap), or hold the line for whole bars more (`out=@l1.floor+3b~0.25b` on a punch, which the compiler lets you tune by trying). Pick one and name its cost in your report. That choice belongs to the director, so make it visible.

Commands:
- `./movas brief s09`: this page, the rules, the timeline, and one scene's source with its derived times.
- `./movas check`: compile and rules, then what your edit changes compared with the last saved version (length, events moved, bar phase, reading slack). Run it after every edit.
- `./movas report`: what your edit changed on screen compared with the last saved version: new or gone defects (collisions, occlusion, off-frame, reading time), clipping, score lines no frame draws, spans with nothing on screen, and each changed text's visible time, size and distance from the frame edge. It draws no pixels and takes about 3 s. `--full` lists every text.
- `./movas at s09.l2` or `./movas at 1:22`: an event's time, or what is at a time.
- `./movas look s09.l2.g3+10f`: renders that frame in about 2 s and prints the PNG path. Read the PNG to see it.
- `./movas look s07.sort..s07.hit+10f [--n=6]`: evenly spaced frames of that range on one sheet, for about the cost of one frame. Use it to see motion, since one frame cannot show which way something moved.
- `./movas render [--preview]`: the whole film, with a chunk cache. Prints a JSON report.
- `./movas save "message"`, `./movas log`, `./movas undo`: versions. `./movas apply patch.json`: all-or-nothing multi-file edit.

`./movas verify [--file=<mp4>] [--preview]` checks a rendered file against the film it came from. It warns when the manifest beside the file names an older source. It fails when the file's frame count differs from the film's, when any punch's text moves between its land and its floor (a snap), or when general flashes exceed 3 per second. The default file is the last master, or the preview with `--preview`. It exits 1 on any defect.

`./movas purity [--scenes=s03,s07]` renders the whole film, then every scene alone, all without the cache, and compares the raw frames. A scene alone that draws differently from the same frames in the full render fails it, because a note starting there would cache frames a full render never draws. Run it after an edit in `programs/` or `runtime/`. A scene with at most 2 differing frames (`--noise=`) passes as run-to-run noise. It takes about as long as two full renders and exits 1 on any defect.

Film-level lines in `film/film.movas`: `film name fps=30`, `format id 1920x1080 default`, `grid beat bpm=120` or `grid seconds` (then `b` means one second), `music bed file= gain= fadein= fadeout=`, `order s01 s02 ...`, `style page gradient=0:#111,1:#000 vignette=0.5`. A scene file starts with its `scene` line. Scenes play in `order`, each from `start=@prev.out` or after the one before it.

Motion lives in `programs/` as code. An edit of copy, timing or sound does not need to open them. A scene with no program plays as blocking: real words and timing over a plain background, so a full-length film exists from the first compile. `clip` lines draw as video, `text`, `cue`, `tag` and `typed` words draw as labels, and `credits` lines draw as a centred list. A headline's word groups shrink to fit the frame. To give a scene a real look, read `tool/programs.md`. A film's own programs live in `film/programs/`, and `./movas help rules` shows how to write a film's own rules.

For a designed card, table or any layout, a program can draw real HTML and CSS with `{op:"html", html, x,y,w,h}`, which is usually shorter than Canvas: `./movas help programs` shows how, and the checks read its words.
