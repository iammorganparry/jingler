import { describe, expect, it } from "vitest"
import { parseCsv } from "./csv-parse.js"

describe("parseCsv", () => {
  it("splits plain comma-delimited rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ])
  })

  it("keeps a delimiter that sits inside a quoted field", () => {
    expect(parseCsv('name,note\n"Doe, John","hi"')).toEqual([
      ["name", "note"],
      ["Doe, John", "hi"]
    ])
  })

  it("unescapes a doubled quote to a single literal quote", () => {
    expect(parseCsv('a\n"she said ""hi"""')).toEqual([["a"], ['she said "hi"']])
  })

  it("reads CRLF and LF the same way", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"]
    ])
  })

  it("preserves a trailing empty field", () => {
    // The dangling comma is a real third cell, not noise to trim.
    expect(parseCsv("a,b,")).toEqual([["a", "b", ""]])
  })

  it("does not grow a phantom row from a trailing newline", () => {
    expect(parseCsv("a\nb\n")).toEqual([["a"], ["b"]])
    expect(parseCsv("a,b\r\n")).toEqual([["a", "b"]])
  })

  it("keeps a newline that lives inside a quoted field", () => {
    expect(parseCsv('a,b\n"line1\nline2",x')).toEqual([
      ["a", "b"],
      ["line1\nline2", "x"]
    ])
  })

  it("auto-detects tab delimiting when no delimiter is given", () => {
    // A .tsv reaches the viewer as kind "csv", so tab has to win on its own.
    expect(parseCsv("a\tb\tc\n1\t2\t3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ])
  })

  it("does not mistake a quoted comma for tab-vs-comma evidence", () => {
    expect(parseCsv('"a, b"\tc\n1\t2')).toEqual([
      ["a, b", "c"],
      ["1", "2"]
    ])
  })

  it("honours an explicit delimiter over detection", () => {
    expect(parseCsv("a;b;c", ";")).toEqual([["a", "b", "c"]])
  })

  it("returns no rows for empty input", () => {
    expect(parseCsv("")).toEqual([])
  })

  it("emits a quoted-but-empty final field as its own row", () => {
    expect(parseCsv('a\n""')).toEqual([["a"], [""]])
  })

  it("tolerates a ragged row with fewer cells than the header", () => {
    expect(parseCsv("a,b,c\n1,2")).toEqual([
      ["a", "b", "c"],
      ["1", "2"]
    ])
  })
})
