#!/usr/bin/env python3
"""The stylesheet's one rule, checked on stdin.

A colour or a duration written as a literal in a rule is a bug: the tokens are a
contract with Dashfile, and one physics for the product means the five
`--motion-*` values and nothing else. A rule that cannot say *why* it is being
broken is a rule people work around silently, so a literal that is genuinely the
right answer says `token-exempt:` and its reason in the comment above it — a
unit conversion, a geometry no token expresses, the reduced-motion kill switch.

Its own file rather than a heredoc inside the hook, because `git show … |
python3 - <<PY` hands python the *heredoc* as its program and the piped content
never arrives. That mistake made this pass on everything.

Reads the file on stdin; prints what it found and exits 1, or exits 0.
"""
import re
import sys

# How far above a line an exemption may be claimed, so a three-line reason still
# covers the declaration it explains.
REACH = 6

COLOUR = re.compile(r"#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl)a?\(")
# Only where a duration means one: a `transition` or an `animation` shorthand.
# `calc(… * 1s)` is caught by the same expression and exempted by name where it
# is a unit conversion rather than a duration somebody chose.
DURATION = re.compile(r"(?:transition|animation)[^;{}]*?(?<![-\w(])(\d*\.?\d+)(m?s)\b")


def comment_lines(lines):
    """Line numbers inside a block comment, so prose about colour does not count."""
    inside, depth = set(), 0
    for i, line in enumerate(lines):
        if depth:
            inside.add(i)
        for token in re.findall(r"/\*|\*/", line):
            depth = max(depth + (1 if token == "/*" else -1), 0)
            if depth:
                inside.add(i)
    return inside


def findings(src):
    lines = src.split("\n")
    inside = comment_lines(lines)
    out = []
    for i, line in enumerate(lines):
        if i in inside:
            continue
        code = re.sub(r"/\*.*?\*/", "", line)
        if "token-exempt" in "\n".join(lines[max(0, i - REACH): i + 1]):
            continue
        if COLOUR.search(code):
            out.append((i + 1, "a literal colour", code.strip()))
            continue
        found = DURATION.search(code)
        # Zero has no design meaning: `0s` is off, not a duration.
        if found and float(found.group(1)) != 0:
            out.append((i + 1, "a literal duration", code.strip()))
    return out


def main():
    bad = findings(sys.stdin.read())
    for line, what, text in bad:
        print(f"app.css:{line}: {what} where a token belongs", file=sys.stderr)
        print(f"  {text[:96]}", file=sys.stderr)
    if bad:
        print(
            "\nUse a token (--motion-fast … --motion-slow, or a colour token),\n"
            "or say `token-exempt: <why>` in the comment above the line.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
