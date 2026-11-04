import re
import subprocess
from .common import ROOT, require, within_root, source_files

PATTERNS=[
    re.compile(r'AKIA[0-9A-Z]{16}'),
    re.compile(r'gh[pousr]_[A-Za-z0-9]{36,255}'),
    re.compile(r'sk-(?:proj-)?[A-Za-z0-9_-]{20,}'),
    re.compile(r'AIza[0-9A-Za-z_-]{35}'),
    re.compile(r'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----'),
]
TEXT={'.md','.json','.py','.ps1','.yml','.yaml','.toml','.txt','.js','.jsx','.ts','.tsx','.env','.gitignore'}

def findings(text):
    return [number for number,line in enumerate(text.splitlines(),1) if any(pattern.search(line) for pattern in PATTERNS)]

def candidates(root):
    if (root/'.git').exists():
        result=subprocess.run(['git','-C',str(root),'ls-files','--cached','--others','--exclude-standard','-z'],capture_output=True,check=True)
        return [root/name for name in result.stdout.decode('utf-8').split('\0') if name]
    return list(source_files(root))

def check_secrets():
    issues=[]
    scanned=0
    for path in candidates(ROOT):
        require(within_root(path.resolve()),'Secret scan candidate outside repository')
        if not path.is_file() or (path.suffix not in TEXT and path.name!='.gitignore'):
            continue
        try:
            text=path.read_text(encoding='utf-8-sig')
        except UnicodeDecodeError:
            continue
        scanned+=1
        for number in findings(text):
            issues.append(f'{path.relative_to(ROOT)}:{number}: suspected secret (value omitted)')
    require(not issues, '\n'.join(issues))
    print(f'PASS secrets: {scanned} candidate text files, strong patterns only')
