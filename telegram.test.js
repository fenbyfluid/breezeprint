import assert from "node:assert/strict";
import test from "node:test";
import { toTextSegments } from "./telegram.js";

test("returns the original text when no supported entities are present", () => {
    assert.equal(toTextSegments("hello", undefined), "hello");
    assert.equal(toTextSegments("hello", [{ type: "url", offset: 0, length: 5 }]), "hello");
    assert.equal(toTextSegments("😀", [{ type: "custom_emoji", offset: 0, length: 2 }]), "😀");
});

test("maps entity types to printer styles", () => {
    const text = "a b c d e";
    const types = ["bold", "italic", "underline", "strikethrough", "spoiler"];
    const entities = types.map((type, index) => ({ type, offset: index * 2, length: 1 }));

    assert.deepEqual(toTextSegments(text, entities), [
        { text: "a", bold: true },
        { text: " " },
        { text: "b", bold: true },
        { text: " " },
        { text: "c", underline: true },
        { text: " " },
        { text: "d", underline: true },
        { text: " " },
        { text: "e", invert: true },
    ]);
});

test("combines overlapping entities and merges adjacent equal styles", () => {
    const segments = toTextSegments("abcd", [
        { type: "bold", offset: 0, length: 3 },
        { type: "italic", offset: 1, length: 3 },
        { type: "underline", offset: 2, length: 1 },
    ]);

    assert.deepEqual(segments, [
        { text: "ab", bold: true },
        { text: "c", bold: true, underline: true },
        { text: "d", bold: true },
    ]);
});

test("uses UTF-16 offsets after astral characters", () => {
    assert.deepEqual(toTextSegments("😀ab", [{ type: "bold", offset: 2, length: 1 }]), [
        { text: "😀" },
        { text: "a", bold: true },
        { text: "b" },
    ]);
});
