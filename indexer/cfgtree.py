"""KSP ConfigNode parser tolerant of ModuleManager patch syntax.

Parses a .cfg file (or the ConfigCache) into a lightweight tree:
    Node = {'header': str, 'keys': [(rawKey, value)], 'children': [Node]}
'header' is the raw node header line (e.g. '@PART[foo]:NEEDS[Waterfall]:FINAL', 'MODULE').
Handles: '//' comments, 'NAME { ... }' same-line braces, headers on the line before '{',
stray blank lines, and value lines containing '{' inside the value (none exist in practice).
"""
from __future__ import annotations


def strip_comment(line: str) -> str:
    i = line.find('//')
    return line[:i] if i >= 0 else line


def parse_text(text: str):
    """Return list of top-level Nodes (plus loose top-level keys as ('', kv) nodes ignored)."""
    lines = text.splitlines()
    root = {'header': '', 'keys': [], 'children': []}
    stack = [root]
    pending = None  # header waiting for '{'
    for raw in lines:
        s = strip_comment(raw).strip()
        if not s:
            continue
        # tokenize brace-only structure
        while s:
            if pending is not None:
                if s.startswith('{'):
                    node = {'header': pending, 'keys': [], 'children': []}
                    stack[-1]['children'].append(node)
                    stack.append(node)
                    pending = None
                    s = s[1:].strip()
                    continue
                else:
                    # header was actually a bare key with no '=' (rare; e.g. flag lines) — drop it
                    pending = None
                    continue
            if s == '}':
                if len(stack) > 1:
                    stack.pop()
                s = ''
            elif s.startswith('{'):
                # anonymous block (shouldn't happen) — treat as unnamed child
                node = {'header': '', 'keys': [], 'children': []}
                stack[-1]['children'].append(node)
                stack.append(node)
                s = s[1:].strip()
            elif '=' in s:
                k, _, v = s.partition('=')
                stack[-1]['keys'].append((k.strip(), v.strip()))
                s = ''
            else:
                # possible node header; may have inline '{'
                if '{' in s:
                    h, _, rest = s.partition('{')
                    node = {'header': h.strip(), 'keys': [], 'children': []}
                    stack[-1]['children'].append(node)
                    stack.append(node)
                    s = rest.strip()
                else:
                    pending = s
                    s = ''
    return root['children']


def parse_file(path: str):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        return parse_text(f.read())
