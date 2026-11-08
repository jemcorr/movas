# Score syntax

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

Music: a bar is 4 beats and the kick is its first beat. A move of whole bars keeps every event's place in the bar. `./movas check` lists what left the kick. When a longer line pushes later events off the kick there are two honest ways out: take the time from inside the scene (start the line earlier, or shrink a gap), or hold the line for whole bars more (`out=@l1.floor+3b~0.25b` on a punch). Pick one and name its cost in your report. That choice belongs to the director, so make it visible.

Film-level lines in `film/film.movas`: `film name fps=30`, `format id 1920x1080 default`, `grid beat bpm=120` or `grid seconds` (then `b` means one second), `music bed file= gain= fadein= fadeout=`, `order s01 s02 ...`, `style page gradient=0:#111,1:#000 vignette=0.5`. A scene file starts with its `scene` line. Scenes play in `order`, each from `start=@prev.out` or after the one before it.

Motion lives in `programs/` as code. An edit of copy, timing or sound does not need to open them. A scene with no program plays as blocking: real words and timing over a plain background, so a full-length film exists from the first compile. `clip` lines draw as video, `text`, `cue`, `tag` and `typed` words draw as labels, and `credits` lines draw as a centred list. A headline's word groups shrink to fit the frame. To give a scene a real look, read `tool/programs.md`. A film's own programs live in `film/programs/`, and `./movas help rules` shows how to write a film's own rules.
