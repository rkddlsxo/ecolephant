"""Update file/document maps; review dates change only with an explicit review option."""
from datetime import date
from pathlib import Path
import argparse
import hashlib
import json
import os
from checks.common import source_files

ROOT=Path(__file__).resolve().parents[2]
SKIP={'.git','.venv','node_modules','__pycache__','tmp','.agents','.codex'}

def relevant(path):
    return path.is_file() and not any(part in SKIP for part in path.relative_to(ROOT).parts)

def write_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')

def status_for(name):
    if name.startswith('harness/reports/') or '/plans/completed/' in name:
        return 'historical'
    if name.startswith('docs/references/'):
        return 'reference'
    if name.startswith('harness/') or name.endswith('AGENTS.md'):
        return 'active'
    return 'draft'

def owner_for(name):
    if name.startswith('harness/'): return 'harness-maintainer'
    for folder in ['frontend','backend','ai']:
        if name.startswith(folder+'/'): return folder
    if name.startswith('docs/ui/'): return 'frontend'
    if name.startswith('docs/measurement/'): return 'ai'
    if name.startswith(('docs/api/','docs/data/')): return 'backend'
    if name.startswith('docs/security/'): return 'security'
    if name.startswith('docs/quality/'): return 'reviewer'
    if name=='PRD.md' or name.startswith(('docs/product/','docs/references/')): return 'product'
    return 'project-maintainer'

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reviewed-on',type=date.fromisoformat,help='Explicitly acknowledge review of new/changed documentation')
    args=parser.parse_args()
    catalog_path=ROOT/'harness/metadata/documents.json'
    old=json.loads(catalog_path.read_text(encoding='utf-8'))['documents'] if catalog_path.exists() else []
    previous={entry['path']:entry for entry in old}
    generated=ROOT/'harness/generated/document-map.md'
    generated.parent.mkdir(parents=True,exist_ok=True)
    if not generated.exists():
        generated.write_text('# 전체 문서 위치\n',encoding='utf-8',newline='\n')
    documents=[]
    for path in sorted(p for p in source_files(ROOT) if p.suffix == '.md'):
        if not relevant(path):
            continue
        name=path.relative_to(ROOT).as_posix()
        entry=dict(previous.get(name,{}))
        digest=hashlib.sha256(path.read_bytes()).hexdigest()
        changed=entry.get('sha256')!=digest
        entry.update(path=name,status=entry.get('status',status_for(name)),owner=entry.get('owner',owner_for(name)),sha256=digest)
        if args.reviewed_on and changed:
            entry['reviewed_on']=args.reviewed_on.isoformat()
        elif 'reviewed_on' not in entry or changed:
            entry['reviewed_on']=None
        documents.append(entry)
    rows=[]
    for entry in documents:
        path=ROOT/entry['path']
        title=path.read_text(encoding='utf-8').splitlines()[0].removeprefix('# ')
        route=os.path.relpath(path,generated.parent).replace('\\','/')
        rows.append(f'| [{title}]({route}) | `{entry["path"]}` | {entry["status"]} |')
    generated.write_text('# 전체 문서 위치\n\n이 표는 build_catalog.py가 생성합니다. 문서는 주제별 색인에서 한 개씩 읽을 수 있습니다.\n\n| 문서 | 경로 | 상태 |\n|---|---|---|\n'+'\n'.join(rows)+'\n',encoding='utf-8',newline='\n')
    for entry in documents:
        entry['sha256']=hashlib.sha256((ROOT/entry['path']).read_bytes()).hexdigest()
    write_json(catalog_path,{'version':'0.2','documents':documents})
    manifest_path=ROOT/'harness/metadata/manifest.json'
    files=sorted(path.relative_to(ROOT).as_posix() for path in source_files(ROOT) if relevant(path) and path.name!='.gitkeep' and path!=manifest_path)
    source=ROOT/'docs/references/source-ui-design.pdf'
    write_json(manifest_path,{'version':'0.2','source':{'path':source.relative_to(ROOT).as_posix(),'sha256':hashlib.sha256(source.read_bytes()).hexdigest()},'required_files':files})
    print(f'Updated maps: {len(documents)} documents, {len(files)} required files; review option={args.reviewed_on}')

if __name__=='__main__':
    main()
