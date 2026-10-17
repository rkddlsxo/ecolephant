import re
from urllib.parse import unquote, urlsplit
from .common import ROOT, require, relative, within_root, markdown_files


def check_links():
    count=0
    md=markdown_files()
    pattern=re.compile(r'!?(?:\[[^\]]+\])\(([^)]+)\)')
    for path in md:
        text=path.read_text(encoding='utf-8')
        require(text.strip(),f'Empty document: {relative(path)}')
        fenced=False
        for line in text.splitlines():
            if line.lstrip().startswith('```'):
                fenced=not fenced
            if not fenced:
                require(not re.match(r'^ {4,}(?:#|\|)',line),f'Indented heading/table in {relative(path)}')
        for match in pattern.finditer(text):
            target=match.group(1).strip().strip('<>')
            parsed=urlsplit(target)
            if parsed.scheme or target.startswith('#'):
                continue
            if not parsed.path:
                continue
            resolved=(path.parent/unquote(parsed.path)).resolve()
            require(within_root(resolved),f'Outside link in {relative(path)}: {target}')
            require(resolved.exists(),f'Broken link in {relative(path)}: {target}')
            count+=1
    print(f'PASS Markdown: {len(md)} documents, {count} local links')
    return md
