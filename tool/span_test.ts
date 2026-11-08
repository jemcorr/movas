// Tests for moveSpan in do.ts. Run with: deno test tool/span_test.ts
import { moveSpan } from "./do.ts";

const assertEquals = (got: unknown, want: unknown) => {
  if (got !== want) throw new Error(`got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

Deno.test("moveSpan follows a changed phrase", () => {
  const oldText = "Oi! Sou o assistente virtual da loja. O T-Cross está reservado. Quer ver outras opções?";
  const newText = "Oi! Aqui é o assistente da loja. O T-Cross já foi reservado. Posso mostrar outras opções?";
  assertEquals(moveSpan("está reservado", oldText, newText), "já foi reservado");
});

Deno.test("moveSpan keeps a span still present", () => {
  assertEquals(moveSpan("outras opções", "Quer ver outras opções?", "Posso ver outras opções?"), "outras opções");
});

Deno.test("moveSpan returns null when the span's words are all deleted", () => {
  assertEquals(moveSpan("b c", "a b c d", "a d"), null);
});

Deno.test("moveSpan keeps a span at the end with punctuation", () => {
  assertEquals(moveSpan("outras opções", "Quer ver outras opções?", "Posso mostrar outras opções?"), "outras opções");
});

Deno.test("moveSpan follows a replaced first word", () => {
  assertEquals(moveSpan("Temos este", "Temos este Renegade.", "Achamos este Renegade."), "Achamos este");
});
