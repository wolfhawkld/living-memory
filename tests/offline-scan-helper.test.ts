import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

const helper = resolve('scripts/offline-scan-helper.py');
function python(body: string) {
  return execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', `
import importlib.util, os, tempfile, json
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('scanner', ${JSON.stringify(helper)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
def process(root, pid, uids=(1000,1000,1000,1000), start='123', parent='1'):
    directory = os.path.join(root, str(pid))
    os.makedirs(os.path.join(directory,'fd'), exist_ok=True)
    with open(os.path.join(directory,'status'),'w') as f: f.write('Uid:\\t' + '\\t'.join(map(str,uids)) + '\\n')
    with open(os.path.join(directory,'stat'),'w') as f: f.write(str(pid) + ' (command name) S ' + parent + ' ' + ' '.join(['0']*17) + ' ' + start + ' 0')
def rejects(fn, code='OFFLINE_CHECK_UNAVAILABLE'):
    try: fn()
    except m.ScanError as e: assert e.code == code and str(e) == code
    else: raise AssertionError('accepted invalid scan')
${body}
`], { encoding: 'utf8' });
}

test('helper scans status UID membership rather than root-owned process directories', () => {
  python(`
with tempfile.TemporaryDirectory() as root:
    process(root, 123, (0,1000,0,0))
    db = os.path.join(root, 'database')
    with open(db,'w') as f: f.write('synthetic')
    os.symlink(db, os.path.join(root,'123','fd','7'))
    s = os.stat(db)
    rejects(lambda: m.scan(root,1000,{(str(s.st_dev),str(s.st_ino))}), 'DATABASE_OPEN')
    m.scan(root,2000,{(str(s.st_dev),str(s.st_ino))})
    # Neither directory ownership nor readlink determines eligibility.
    original = os.stat
    def fd_only(path):
        assert '/fd/' in path
        return original(path)
    with patch.object(m.os,'stat',side_effect=fd_only):
        rejects(lambda: m.scan(root,1000,{(str(s.st_dev),str(s.st_ino))}), 'DATABASE_OPEN')
`);
});

test('helper ignores ENOENT races but rejects denied descriptors and unknown UID status', () => {
  python(`
with tempfile.TemporaryDirectory() as root:
    process(root,123)
    os.symlink('/definitely-missing-synthetic-target',os.path.join(root,'123','fd','7'))
    m.scan(root,1000,{('1','1')})
    original=m.os.listdir
    def denied(path):
        if path.endswith('/fd'): raise PermissionError('PRIVATE ERROR CONTENT')
        return original(path)
    with patch.object(m.os,'listdir',side_effect=denied): rejects(lambda: m.scan(root,1000,{('1','1')}))
    with open(os.path.join(root,'123','status'),'w') as f: f.write('Uid: bad')
    rejects(lambda: m.scan(root,1000,{('1','1')}))
`);
});

test('helper checks parent identity, all four UIDs, starttime and ancestry', () => {
  python(`
with tempfile.TemporaryDirectory() as root:
    process(root,123)
    process(root,456,(0,0,0,0),parent='123')
    m.assert_parent(root,123,'123',1000)
    m.assert_ancestor(root,456,123)
    rejects(lambda: m.assert_parent(root,123,'124',1000))
    process(root,123,(1000,1000,0,1000))
    rejects(lambda: m.assert_parent(root,123,'123',1000))
    rejects(lambda: m.assert_ancestor(root,456,789))
`);
});

test('helper strictly bounds requests and rejects replay, paths, invalid identities and duplicate JSON keys', () => {
  python(`
n='a'*64
init={'version':1,'type':'init','sequence':0,'nonce':n,'uid':'1000','parentPid':'123','parentStart':'321'}
m.validate_init(init)
for key,value in [('version',2),('uid','0'),('sequence',True),('parentStart','-1'),('nonce','short')]:
    rejects(lambda key=key,value=value: m.validate_init(dict(init,**{key:value})))
request={'type':'scan','sequence':1,'nonce':n,'identities':[{'dev':'1','ino':'2'}]}
assert m.validate_request(request,n,1) == {('1','2')}
rejects(lambda: m.validate_request(request,n,2))
rejects(lambda: m.validate_request(dict(request,nonce='b'*64),n,1))
rejects(lambda: m.validate_request(dict(request,path='/private'),n,1))
rejects(lambda: m.validate_request(dict(request,identities=[{'dev':'1','ino':'2'}]*9),n,1))
rejects(lambda: m.validate_request(dict(request,identities=[{'dev':'1','ino':'2'}]*2),n,1))
rejects(lambda: m.validate_request(dict(request,identities=[{'dev':1,'ino':'2'}]),n,1))
rejects(lambda: m.validate_request(dict(request,identities=[{'dev':'-1','ino':'2'}]),n,1))
rejects(lambda: json.loads('{"nonce":"first","nonce":"second"}',object_pairs_hook=m.unique_object))
assert m.validate_request({'type':'close','sequence':2,'nonce':n},n,2) is None
`);
});

test('real helper entry refuses non-root and extra arguments without leaking input', { skip: process.getuid?.() === 0 }, () => {
  const input = JSON.stringify({ version: 1, type: 'init', sequence: 0, nonce: 'a'.repeat(64), uid: String(process.getuid!()), parentPid: String(process.pid), parentStart: '1' }) + '\n';
  const run = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', '-u', helper], { input, encoding: 'utf8' });
  assert.equal(run.status, 1); assert.equal(run.stderr, '');
  assert.deepEqual(JSON.parse(run.stdout), { version: 1, nonce: 'a'.repeat(64), sequence: 0, code: 'AUTH_REQUIRED' });
  const invalid = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', '-u', helper, '--proc-root=/private'], { input, encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.equal(invalid.stderr, '');
});

test('helper parses only bounded numeric identity fields despite arbitrary comm bytes', () => {
  python(`
with tempfile.TemporaryDirectory() as root:
    process(root,123)
    with open(os.path.join(root,'123','status'),'wb') as f: f.write(b'Name: \\xff\\xfe\\nUid: 1000 1000 1000 1000\\n')
    with open(os.path.join(root,'123','stat'),'wb') as f: f.write(b'123 (\\xff)\\xfe name) S 1 ' + b'0 '*17 + b'123 0')
    m.assert_parent(root,123,'123',1000)
    m.scan(root,1000,{('1','1')})
`);
});

test('helper waits through idle periods longer than scan timeout but checks parent continuously', () => {
  python(`
import io
with tempfile.TemporaryDirectory() as root:
    process(root,123)
    nonce='a'*64
    init={'version':1,'type':'init','sequence':0,'nonce':nonce,'uid':'1000','parentPid':'123','parentStart':'123'}
    close={'type':'close','sequence':1,'nonce':nonce}
    chunks=[(json.dumps(init)+'\\n').encode(), (json.dumps(close)+'\\n').encode()]
    clock=[0]
    turns=[0]
    checks=[0]
    class Selector:
        def register(self,*args): pass
        def select(self,timeout):
            turns[0]+=1
            if turns[0] in (1,5): return [True]
            clock[0]+=20
            return []
        def close(self): pass
    class Input:
        buffer=io.BytesIO()
        def fileno(self): return 0
    original=m.assert_parent
    def check(_root,*args):
        checks[0]+=1
        return original(root,*args)
    output=io.StringIO()
    with patch.object(m.sys,'argv',['helper']), patch.object(m.sys,'stdin',Input()), patch.object(m.sys,'stdout',output), patch.object(m.selectors,'DefaultSelector',Selector), patch.object(m.time,'monotonic',lambda:clock[0]), patch.object(m.os,'read',lambda *args: chunks.pop(0)), patch.object(m.os,'geteuid',lambda:0), patch.dict(m.os.environ,{'SUDO_UID':'1000'}), patch.object(m,'assert_parent',check), patch.object(m,'assert_ancestor',lambda *args:None):
        assert m.main() == 0
    assert clock[0] == 60 and checks[0] >= 4
    replies=[json.loads(line) for line in output.getvalue().splitlines()]
    assert [value['sequence'] for value in replies] == [0,1]
    assert all(value['version']==1 and value['code']=='OK' for value in replies)
`);
});

test('helper exits on input EOF and refuses a dead parent without reading any database', () => {
  python(`
import io
for scenario in ('eof','parent-dead'):
    with tempfile.TemporaryDirectory() as root:
        process(root,123)
        nonce='a'*64
        init={'version':1,'type':'init','sequence':0,'nonce':nonce,'uid':'1000','parentPid':'123','parentStart':'123'}
        chunks=[(json.dumps(init)+'\\n').encode(), b'']
        class Selector:
            def register(self,*args): pass
            def select(self,timeout): return [True]
            def close(self): pass
        class Input:
            buffer=io.BytesIO()
            def fileno(self): return 0
        original=m.assert_parent
        checks=[0]
        def check(_root,*args):
            checks[0]+=1
            if scenario=='parent-dead' and checks[0]>1: raise m.ScanError()
            return original(root,*args)
        output=io.StringIO()
        with patch.object(m.sys,'argv',['helper']), patch.object(m.sys,'stdin',Input()), patch.object(m.sys,'stdout',output), patch.object(m.selectors,'DefaultSelector',Selector), patch.object(m.os,'read',lambda *args: chunks.pop(0)), patch.object(m.os,'geteuid',lambda:0), patch.dict(m.os.environ,{'SUDO_UID':'1000'}), patch.object(m,'assert_parent',check), patch.object(m,'assert_ancestor',lambda *args:None):
            assert m.main() == (0 if scenario=='eof' else 1)
        replies=[json.loads(line) for line in output.getvalue().splitlines()]
        assert replies[0]['code']=='OK'
        if scenario=='parent-dead': assert replies[-1]['code']=='OFFLINE_CHECK_UNAVAILABLE'
`);
});


test('helper ignores vanished PIDs but refuses missing status or fd while PID remains', () => {
  python(`
with tempfile.TemporaryDirectory() as root:
    process(root,123)
    os.unlink(os.path.join(root,'123','status'))
    rejects(lambda: m.scan(root,1000,{('1','1')}))
    process(root,123)
    os.rmdir(os.path.join(root,'123','fd'))
    rejects(lambda: m.scan(root,1000,{('1','1')}))
    original=m.os.listdir
    def vanished(path):
        if path == root: return ['456']
        return original(path)
    with patch.object(m.os,'listdir',side_effect=vanished): m.scan(root,1000,{('1','1')})
`);
});

test('helper initialization and interruption never expose exception tracebacks', () => {
  python(`
import io
for failure in ('register','interrupt','cleanup'):
    output=io.StringIO()
    errors=io.StringIO()
    class Selector:
        def register(self,*args):
            if failure=='register': raise OSError('/PRIVATE/PATH')
            if failure=='interrupt': raise KeyboardInterrupt('/PRIVATE/PATH')
        def select(self,*args): raise KeyboardInterrupt('/PRIVATE/PATH')
        def close(self):
            if failure=='cleanup': raise KeyboardInterrupt('/PRIVATE/PATH')
    class Input:
        buffer=io.BytesIO()
        def fileno(self): return 0
    with patch.object(m.sys,'argv',['helper']), patch.object(m.sys,'stdin',Input()), patch.object(m.sys,'stdout',output), patch.object(m.sys,'stderr',errors), patch.object(m.selectors,'DefaultSelector',Selector):
        assert m.main() == 1
    assert output.getvalue() == '' and errors.getvalue() == ''
`);
});
