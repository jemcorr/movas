## The chat format

This film says `use chat` in `film/meaning.txt`.

- `msg id in=panel side=in|out @t "bubble text"` places one bubble. `chat id @t q= a= reply=` places a question and its reply.
- A `panel` line gives a panel `title=`, `composer=`, `x=`, `y=`, `w=`, `h=` and `keep=`.
- A scene with no program draws one chat panel per `in=`. `side=in` is white on the left. `side=out` is green on the right.
- `fact role side=<name> sent` in `film/meaning.txt` gives this film another sending side. It draws as sent, and the rules treat it as sent.
- Who speaks does not rest on bubble colour. Show it with the panel title, a badge or a label.

In a program: `import { chatPanel } from "../formats/chat.js"` under `film/programs/scenes/`. `chatPanel(comp, {x,y,w,h,size,msgs,f,name,composer,persp:{d,ry,rx},keep,id})` draws a panel. `msgs` are `{id, side:"in"|"out", at, text}` with `at` local. Read the function before using it: it may lack something your scene needs (typing dots, highlights, a card in a bubble).
