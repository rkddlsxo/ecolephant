import ast
import re
from pathlib import Path
from .common import ROOT, load, require, source_files

def target_package(name, path, root, packages):
    if name.startswith('.'):
        try:
            parts=(path.parent/name).resolve().relative_to(root.resolve()).parts
            return parts[0] if parts and parts[0] in packages else None
        except ValueError:
            return None
    pieces=name.replace('\\','/').split('/')
    if pieces[0] in packages:
        return pieces[0]
    if pieces[0].startswith('@') and len(pieces)>1 and pieces[1] in packages:
        return pieces[1]
    return None

def inspect_source(path, root, policy):
    text=path.read_text(encoding='utf-8-sig')
    source=path.relative_to(root).parts[0]
    packages=policy['packages']
    imports=[]
    issues=[]
    pure=source==policy['pure_package']
    if path.suffix=='.py':
        try:
            tree=ast.parse(text)
        except SyntaxError:
            return [f'{path.relative_to(root)}: invalid Python syntax']
        for node in ast.walk(tree):
            if isinstance(node,ast.Import):
                imports.extend(alias.name for alias in node.names)
            elif isinstance(node,ast.ImportFrom):
                if node.level:
                    base=path.parent
                    for _ in range(node.level-1):
                        base=base.parent
                    target=base/(node.module or '').replace('.','/')
                    candidates=[target] if node.module else [target/alias.name for alias in node.names]
                    for candidate in candidates:
                        try:
                            pieces=candidate.resolve().relative_to(root.resolve()).parts
                            if pieces:
                                imports.append(pieces[0])
                        except ValueError:
                            issues.append(f'{path.relative_to(root)}: relative import leaves repository')
                elif node.module:
                    imports.append(node.module)
            elif pure and isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id in policy['python_forbidden_calls']:
                issues.append(f'{path.relative_to(root)}:{node.lineno}: direct I/O in analysis package')
    else:
        clean=re.sub(r'/\*.*?\*/|//[^\n]*','',text,flags=re.S)
        pattern=r'(?:\bfrom\s*|\b(?:import|require)\s*\(\s*|\bimport\s*)([\x22\x27])([^\x22\x27]+)\1'
        imports=[m.group(2) for m in re.finditer(pattern,clean)]
        if pure:
            for call in policy['js_forbidden_calls']:
                if re.search(r'\b'+re.escape(call)+r'\s*\(',clean):
                    issues.append(f'{path.relative_to(root)}: direct {call} in analysis package')
            for name in policy['js_forbidden_objects']:
                if re.search(r'\b'+re.escape(name)+r'\s*[.\[]',clean):
                    issues.append(f'{path.relative_to(root)}: browser object in analysis package')
    for name in imports:
        if name.startswith('.'):
            try:
                (path.parent/name).resolve().relative_to(root.resolve())
            except ValueError:
                issues.append(f'{path.relative_to(root)}: relative import leaves repository')
        target=target_package(name.replace('.','/',1) if path.suffix=='.py' and not name.startswith('.') else name,path,root,packages)
        if target and target!=source and target not in packages[source]['allowed_dependencies']:
            issues.append(f'{path.relative_to(root)}: forbidden dependency {source} -> {target}')
        if pure:
            blocked=policy['python_forbidden_imports'] if path.suffix=='.py' else policy['js_forbidden_imports']
            if any(name==prefix or name.startswith(prefix+'.') or name.startswith(prefix+'/') for prefix in blocked):
                issues.append(f'{path.relative_to(root)}: I/O import in analysis package')
    return issues

def check_architecture():
    policy=load('harness/metadata/architecture-policy.json')
    issues=[]
    count=0
    for package in policy['packages']:
        for path in source_files(ROOT/package):
            if path.is_file() and path.suffix in policy['source_extensions'] and not any(p in {'.venv','node_modules','dist','__pycache__'} for p in path.parts):
                count+=1
                issues.extend(inspect_source(path,ROOT,policy))
    require(not issues, '\n'.join(issues))
    if count:
        print(f'PASS architecture: {count} product source files, explicit dependency/I/O patterns')
    else:
        print('INFO architecture: policy checked; product source import checks not applicable (no implementation files)')
