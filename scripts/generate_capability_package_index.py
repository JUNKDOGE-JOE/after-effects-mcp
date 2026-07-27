#!/usr/bin/env python3
"""Generate fail-closed JSON indexes for capability-package briefs.

With no BRIEF arguments, every ``docs/capability-packages/*.md`` file is
indexed. Derived files are written below ``.cache/capability-package-index``.
Use ``-`` with ``--source-name`` to validate a brief supplied on stdin.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BRIEF_ROOT = REPOSITORY_ROOT / "docs/capability-packages"
DEFAULT_OUTPUT_ROOT = REPOSITORY_ROOT / ".cache/capability-package-index"
HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
FENCE = re.compile(r"^\s*(`{3,}|~{3,})([A-Za-z0-9_-]*)\s*$")
PUBLIC_TOOL = re.compile(r"\bae_[A-Za-z][A-Za-z0-9_]*\b")
CAPABILITY_ID = re.compile(r"\bae(?:\.[a-z0-9-]+){2,}\b")
JSON_PROPERTY = r'^\s*"{tool}"\s*:\s*\{{'


class ParseFailure(ValueError):
    """The brief does not expose enough structure for a trustworthy index."""


@dataclass(frozen=True)
class HeadingRange:
    level: int
    title: str
    start: int
    end: int
    path: tuple[str, ...]


@dataclass(frozen=True)
class FenceRange:
    language: str
    start: int
    end: int
    content_start: int
    content_end: int


@dataclass(frozen=True)
class Table:
    header: tuple[str, ...]
    rows: tuple[tuple[int, tuple[str, ...]], ...]
    start: int
    end: int


def _plain(value: str) -> str:
    return re.sub(r"[`*]", "", value).strip()


def _normalized(value: str) -> str:
    value = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", _plain(value))
    value = value.replace("colour", "color")
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def _range(start: int, end: int) -> dict[str, int]:
    return {"start": start, "end": end}


def _split_table_row(line: str) -> tuple[str, ...]:
    value = line.strip()
    if value.startswith("|"):
        value = value[1:]
    if value.endswith("|"):
        value = value[:-1]
    return tuple(cell.strip() for cell in re.split(r"(?<!\\)\|", value))


def _is_separator(row: Sequence[str]) -> bool:
    return bool(row) and all(
        re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) is not None for cell in row
    )


def _headings(lines: Sequence[str]) -> list[HeadingRange]:
    raw: list[tuple[int, int, str]] = []
    for line_number, line in enumerate(lines, 1):
        match = HEADING.match(line)
        if match:
            raw.append((line_number, len(match.group(1)), match.group(2).strip()))
    if not raw or raw[0][1] != 1:
        raise ParseFailure("document must begin with one level-1 heading")

    result: list[HeadingRange] = []
    stack: list[tuple[int, str]] = []
    for index, (start, level, title) in enumerate(raw):
        while stack and stack[-1][0] >= level:
            stack.pop()
        path = tuple(member for _, member in stack) + (title,)
        stack.append((level, title))
        end = len(lines)
        for next_start, next_level, _ in raw[index + 1 :]:
            if next_level <= level:
                end = next_start - 1
                break
        result.append(HeadingRange(level, title, start, end, path))
    return result


def _fences(lines: Sequence[str]) -> list[FenceRange]:
    result: list[FenceRange] = []
    index = 0
    while index < len(lines):
        match = FENCE.match(lines[index])
        if match is None:
            index += 1
            continue
        marker = match.group(1)
        language = match.group(2).lower()
        close = re.compile(rf"^\s*{re.escape(marker[0])}{{{len(marker)},}}\s*$")
        for candidate in range(index + 1, len(lines)):
            if close.match(lines[candidate]):
                result.append(
                    FenceRange(
                        language=language,
                        start=index + 1,
                        end=candidate + 1,
                        content_start=index + 2,
                        content_end=candidate,
                    )
                )
                index = candidate + 1
                break
        else:
            raise ParseFailure(f"unclosed fenced block at line {index + 1}")
    return result


def _tables(lines: Sequence[str]) -> list[Table]:
    result: list[Table] = []
    index = 0
    while index + 1 < len(lines):
        if not lines[index].lstrip().startswith("|"):
            index += 1
            continue
        header = _split_table_row(lines[index])
        separator = _split_table_row(lines[index + 1])
        if len(header) != len(separator) or not _is_separator(separator):
            index += 1
            continue
        rows: list[tuple[int, tuple[str, ...]]] = []
        candidate = index + 2
        while candidate < len(lines) and lines[candidate].lstrip().startswith("|"):
            cells = _split_table_row(lines[candidate])
            if len(cells) != len(header):
                raise ParseFailure(f"table row at line {candidate + 1} has the wrong column count")
            rows.append((candidate + 1, cells))
            candidate += 1
        result.append(Table(header, tuple(rows), index + 1, candidate))
        index = candidate
    return result


def _section_at(headings: Sequence[HeadingRange], line: int) -> HeadingRange:
    candidates = [heading for heading in headings if heading.start <= line <= heading.end]
    if not candidates:
        raise ParseFailure(f"line {line} is outside the document heading structure")
    return max(candidates, key=lambda heading: heading.level)


def _has_ancestor(
    headings: Sequence[HeadingRange], line: int, pattern: re.Pattern[str]
) -> bool:
    return any(
        heading.start <= line <= heading.end and pattern.search(_normalized(heading.title))
        for heading in headings
    )


def _tool_registry(tables: Sequence[Table]) -> tuple[Table, list[dict[str, Any]]]:
    registries = [
        table
        for table in tables
        if any(_normalized(cell) == "public mcp tool" for cell in table.header)
    ]
    if len(registries) != 1:
        raise ParseFailure(
            f"expected one 'Public MCP tool' registry table, found {len(registries)}"
        )
    table = registries[0]
    tool_column = next(
        index
        for index, cell in enumerate(table.header)
        if _normalized(cell) == "public mcp tool"
    )
    tools: list[dict[str, Any]] = []
    for line, cells in table.rows:
        matches = PUBLIC_TOOL.findall(_plain(cells[tool_column]))
        if len(matches) != 1:
            raise ParseFailure(f"public-tool row at line {line} does not name exactly one tool")
        name = matches[0]
        capabilities = [
            match
            for cell in cells
            for match in CAPABILITY_ID.findall(_plain(cell))
        ]
        kinds = [
            _normalized(cell)
            for cell in cells
            if _normalized(cell) in {"read", "write"}
        ]
        if kinds:
            kind = kinds[0]
        elif name.startswith(("ae_get", "ae_list", "ae_read", "ae_inspect")):
            kind = "read"
        elif name.startswith(("ae_add", "ae_create", "ae_delete", "ae_set", "ae_apply")):
            kind = "write"
        else:
            raise ParseFailure(f"cannot determine read/write kind for {name} at line {line}")
        tools.append(
            {
                "name": name,
                "kind": kind,
                "nativeCapability": capabilities[0] if capabilities else None,
                "registryLine": line,
            }
        )
    names = [tool["name"] for tool in tools]
    if not names or len(names) != len(set(names)):
        raise ParseFailure("public-tool registry is empty or contains duplicate tool names")
    return table, tools


def _json_property_range(lines: Sequence[str], fence: FenceRange, tool: str) -> tuple[int, int] | None:
    pattern = re.compile(JSON_PROPERTY.format(tool=re.escape(tool)))
    start: int | None = None
    balance = 0
    in_string = False
    escaped = False
    for line_number in range(fence.content_start, fence.content_end + 1):
        line = lines[line_number - 1]
        if start is None:
            if pattern.match(line) is None:
                continue
            start = line_number
            fragment = line[line.index("{") :]
        else:
            fragment = line
        for character in fragment:
            if escaped:
                escaped = False
            elif character == "\\" and in_string:
                escaped = True
            elif character == '"':
                in_string = not in_string
            elif not in_string and character == "{":
                balance += 1
            elif not in_string and character == "}":
                balance -= 1
        if start is not None and balance == 0:
            return start, line_number
    if start is not None:
        raise ParseFailure(f"unbalanced JSON object for {tool} at line {start}")
    return None


def _schema_contract(
    lines: Sequence[str],
    headings: Sequence[HeadingRange],
    fences: Sequence[FenceRange],
    registry: Table,
    tool: str,
) -> dict[str, Any]:
    schema_fences = [
        fence
        for fence in fences
        if fence.language == "json"
        and _has_ancestor(headings, fence.start, re.compile(r"\bschemas?\b"))
    ]
    explicit: list[dict[str, Any]] = []
    occupied: set[int] = set()
    for index, fence in enumerate(schema_fences):
        located = _json_property_range(lines, fence, tool)
        if located is not None:
            occupied.add(index)
            section = _section_at(headings, fence.start)
            explicit.append(
                {
                    "section": section.title,
                    "lineRange": _range(*located),
                }
            )
    if explicit:
        shared = []
        for index, fence in enumerate(schema_fences):
            if index in occupied:
                continue
            section = _section_at(headings, fence.start)
            shared.append(
                {
                    "section": section.title,
                    "lineRange": _range(fence.content_start, fence.content_end),
                }
            )
        return {"status": "explicit", "toolBlocks": explicit, "sharedBlocks": shared}

    named_schema = re.compile(r'^\s*"ae_[A-Za-z][A-Za-z0-9_]*"\s*:\s*\{')
    if any(
        named_schema.match(lines[line_number - 1])
        for fence in schema_fences
        for line_number in range(fence.content_start, fence.content_end + 1)
    ):
        raise ParseFailure(
            f"schema blocks name other public tools but omit {tool}; refusing narrative fallback"
        )

    section = _section_at(headings, registry.start)
    return {
        "status": "narrative",
        "toolBlocks": [],
        "sharedBlocks": [
            {"section": section.title, "lineRange": _range(section.start, section.end)}
        ],
        "note": (
            "No explicit JSON schema block names this tool; the range is the "
            "brief's shared public contract and is not represented as JSON Schema."
        ),
    }


def _execution_path(
    lines: Sequence[str],
    headings: Sequence[HeadingRange],
    fences: Sequence[FenceRange],
) -> dict[str, Any]:
    matches: list[dict[str, Any]] = []
    for fence in fences:
        text = "\n".join(lines[fence.content_start - 1 : fence.content_end])
        if re.search(r"public MCP", text, re.IGNORECASE) and "->" in text:
            section = _section_at(headings, fence.start)
            matches.append(
                {
                    "section": section.title,
                    "lineRange": _range(fence.content_start, fence.content_end),
                    "text": text.strip(),
                }
            )
    if not matches:
        raise ParseFailure("no fenced public-MCP execution path was found")
    return {"paths": matches}


def _tool_aliases(tool: dict[str, Any]) -> set[str]:
    name = re.sub(r"^ae_", "", tool["name"])
    words = _normalized(name).split()
    if words and words[0] in {"add", "apply", "create", "delete", "get", "list", "set"}:
        words = words[1:]
    aliases = {" ".join(words[index:]) for index in range(len(words))}
    capability = tool.get("nativeCapability")
    if capability:
        cap_words = _normalized(capability).split()
        aliases.update(" ".join(cap_words[index:]) for index in range(len(cap_words)))
    return {alias for alias in aliases if alias}


def _matching_row(tool: dict[str, Any], rows: Iterable[tuple[int, tuple[str, ...]]]) -> list[
    tuple[int, tuple[str, ...]]
]:
    aliases = _tool_aliases(tool)
    matches = []
    for line, cells in rows:
        first = _normalized(cells[0])
        exact_tool = tool["name"] in _plain(cells[0])
        if exact_tool or any(
            first == alias
            or alias.endswith(" " + first)
            or alias.startswith(first + " ")
            for alias in aliases
        ):
            matches.append((line, cells))
    return matches


def _paragraphs(lines: Sequence[str]) -> list[tuple[int, int, str]]:
    result = []
    start: int | None = None
    content: list[str] = []
    in_fence = False
    for line_number, line in enumerate((*lines, ""), 1):
        if FENCE.match(line):
            in_fence = not in_fence
        excluded = (
            in_fence
            or not line.strip()
            or HEADING.match(line) is not None
            or line.lstrip().startswith("|")
        )
        if excluded:
            if content and start is not None:
                result.append((start, line_number - 1, " ".join(part.strip() for part in content)))
            start = None
            content = []
        else:
            if start is None:
                start = line_number
            content.append(line)
    return result


def _undo_model(
    lines: Sequence[str],
    headings: Sequence[HeadingRange],
    tables: Sequence[Table],
    tool: dict[str, Any],
) -> dict[str, Any]:
    if tool["kind"] == "read":
        return {
            "disposition": "not-applicable",
            "lineRanges": [_range(tool["registryLine"], tool["registryLine"])],
            "description": "The public-tool registry classifies this tool as a read.",
        }

    undo_tables = [
        table
        for table in tables
        if any("undo" in _normalized(cell).split() for cell in table.header)
    ]
    row_matches = [
        (table, row)
        for table in undo_tables
        for row in _matching_row(tool, table.rows)
    ]
    if len(row_matches) == 1:
        _, (line, cells) = row_matches[0]
        description = " | ".join(_plain(cell) for cell in cells[1:])
        normalized = _normalized(description)
        disposition = (
            "not-undoable"
            if "not undoable" in normalized or "undo none" in normalized
            else "real-ae-undo"
        )
        return {
            "disposition": disposition,
            "lineRanges": [_range(line, line)],
            "description": description,
        }
    if len(row_matches) > 1:
        raise ParseFailure(f"multiple Undo rows ambiguously match {tool['name']}")

    candidates = []
    for start, end, text in _paragraphs(lines):
        if not _has_ancestor(headings, start, re.compile(r"(fixture|interaction|undo|acceptance)")):
            continue
        normalized = _normalized(text)
        if "undo" in normalized.split() and re.search(r"\b(each|every|all)\b.*\bwrite", normalized):
            candidates.append((start, end, text))
    if not candidates:
        raise ParseFailure(f"no reliable Undo model was found for write tool {tool['name']}")
    start, end, description = candidates[0]
    return {
        "disposition": "real-ae-undo",
        "lineRanges": [_range(start, end)],
        "description": description,
    }


def _acceptance_disposition(
    headings: Sequence[HeadingRange],
    tables: Sequence[Table],
    tool: dict[str, Any],
) -> dict[str, Any]:
    sections = [
        heading
        for heading in headings
        if heading.level == 2 and "acceptance" in _normalized(heading.title).split()
    ]
    if not sections:
        raise ParseFailure("no level-2 acceptance section was found")
    matching_rows = []
    for table in tables:
        if not any(section.start <= table.start <= section.end for section in sections):
            continue
        for line, cells in table.rows:
            if tool["name"] in " | ".join(cells):
                matching_rows.append(
                    {
                        "lineRange": _range(line, line),
                        "description": " | ".join(_plain(cell) for cell in cells),
                    }
                )
    if matching_rows:
        return {
            "disposition": "required",
            "basis": "tool-specific acceptance row",
            "lineRanges": [row["lineRange"] for row in matching_rows],
            "details": [row["description"] for row in matching_rows],
        }
    section = sections[0]
    return {
        "disposition": "required",
        "basis": "package-level acceptance section",
        "lineRanges": [_range(section.start, section.end)],
    }


def build_index(text: str, source_name: str) -> dict[str, Any]:
    lines = text.splitlines()
    if not lines:
        raise ParseFailure("brief is empty")
    headings = _headings(lines)
    fences = _fences(lines)
    tables = _tables(lines)
    registry, tools = _tool_registry(tables)
    execution = _execution_path(lines, headings, fences)

    indexed_tools = []
    for tool in tools:
        indexed_tools.append(
            {
                **tool,
                "schema": _schema_contract(lines, headings, fences, registry, tool["name"]),
                "executionPath": execution,
                "undoModel": _undo_model(lines, headings, tables, tool),
                "acceptance": _acceptance_disposition(headings, tables, tool),
            }
        )
    return {
        "schemaVersion": 1,
        "source": {
            "path": source_name,
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "lineCount": len(lines),
        },
        "sections": [
            {
                "name": heading.title,
                "level": heading.level,
                "path": list(heading.path),
                "lineRange": _range(heading.start, heading.end),
            }
            for heading in headings
        ],
        "tools": indexed_tools,
    }


def _write_if_changed(path: Path, content: str) -> bool:
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)
    return True


def _arguments(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "briefs",
        nargs="*",
        help="Markdown briefs to index; defaults to docs/capability-packages/*.md; use - for stdin",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_ROOT,
        help=f"derived output directory (default: {DEFAULT_OUTPUT_ROOT.relative_to(REPOSITORY_ROOT)})",
    )
    parser.add_argument("--stdout", action="store_true", help="print one index instead of writing it")
    parser.add_argument("--source-name", help="source path recorded when BRIEF is -")
    parsed = parser.parse_args(argv)
    if parsed.stdout and len(parsed.briefs) != 1:
        parser.error("--stdout requires exactly one explicit brief")
    if "-" in parsed.briefs:
        if len(parsed.briefs) != 1 or not parsed.source_name:
            parser.error("stdin requires exactly one '-' brief and --source-name")
    elif parsed.source_name:
        parser.error("--source-name is only valid with stdin")
    return parsed


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _arguments(argv)
    briefs = arguments.briefs or [
        str(path.relative_to(REPOSITORY_ROOT))
        for path in sorted(DEFAULT_BRIEF_ROOT.glob("*.md"))
    ]
    if not briefs:
        print("error: no capability-package briefs were found", file=sys.stderr)
        return 2

    parsed: list[tuple[str, dict[str, Any]]] = []
    failures: list[str] = []
    for brief in briefs:
        if brief == "-":
            source_name = arguments.source_name
            text = sys.stdin.read()
        else:
            path = Path(brief)
            if not path.is_absolute():
                path = REPOSITORY_ROOT / path
            source_name = (
                str(path.relative_to(REPOSITORY_ROOT))
                if path.is_relative_to(REPOSITORY_ROOT)
                else str(path)
            )
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeError) as error:
                failures.append(f"{source_name}: could not read brief: {error}")
                continue
        try:
            parsed.append((source_name, build_index(text, source_name)))
        except ParseFailure as error:
            failures.append(f"{source_name}: {error}")

    if failures:
        for failure in failures:
            print(f"error: {failure}", file=sys.stderr)
        print("No indexes written because at least one brief was not reliable to parse.", file=sys.stderr)
        return 2

    rendered = [
        (source, json.dumps(index, ensure_ascii=False, indent=2) + "\n")
        for source, index in parsed
    ]
    if arguments.stdout:
        sys.stdout.write(rendered[0][1])
        return 0

    changed = 0
    for source, content in rendered:
        output = arguments.output_dir / f"{Path(source).stem}.index.json"
        wrote = _write_if_changed(output, content)
        changed += int(wrote)
        print(f"{'wrote' if wrote else 'unchanged'} {output}")
    print(f"indexed={len(rendered)} changed={changed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
