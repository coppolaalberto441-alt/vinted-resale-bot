import test from "node:test";
import assert from "node:assert/strict";
import { isSetupCommand, topicColor } from "../src/index.js";

test("recognizes setup commands with an optional bot username", () => {
  assert.equal(isSetupCommand("/setup"), true);
  assert.equal(isSetupCommand(" /setup@vingtoBot "), true);
  assert.equal(isSetupCommand("/setup-now"), false);
  assert.equal(isSetupCommand("setup"), false);
});

test("topic colors repeat only after all six Telegram colors", () => {
  const colors = Array.from({ length: 6 }, (_, index) => topicColor(index));
  assert.equal(new Set(colors).size, 6);
  assert.equal(topicColor(6), topicColor(0));
});
