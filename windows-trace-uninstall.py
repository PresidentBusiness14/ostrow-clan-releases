"""Trace only the disposable CI app's old uninstaller, never a user computer."""
import os
import pathlib
import shutil
import tempfile
import threading
import time
import frida

if os.name != 'nt' or os.environ.get('CI') != 'true':
    raise RuntimeError('Disposable Windows CI only')
root = pathlib.Path(os.environ['LOCALAPPDATA']) / 'Programs'
original = next(root.rglob('Uninstall Ostrow Clan.exe'))
directory = pathlib.Path(tempfile.mkdtemp(prefix='household-uninstall-trace-'))
target = directory / 'old-uninstaller.exe'
shutil.copy2(original, target)
device = frida.get_local_device()
pid = device.spawn([str(target), '/S', '/KEEP_APP_DATA', '/currentuser', '--updated', '_?=' + str(original.parent)])
sessions = {}
source = r"""
const kernel = Process.getModuleByName('kernel32.dll');
const user = Process.getModuleByName('user32.dll');
function string(p) { try { return p.readUtf16String(); } catch { return '?'; } }
for (const name of ['MoveFileW', 'MoveFileExW', 'CreateDirectoryW']) {
 const pointer = kernel.findExportByName(name);
 if (!pointer) continue;
 Interceptor.attach(pointer, {
  onEnter(args) { this.from=string(args[0]); this.to=name.startsWith('Move')?string(args[1]):null; },
  onLeave(result) { if(name.startsWith('Move')||result.toInt32()===0) send({name,from:this.from,to:this.to,result:result.toInt32(),error:this.lastError}); }
 });
}
Interceptor.attach(kernel.getExportByName('ExitProcess'), {onEnter(args) {send({exitCode:args[0].toInt32()});}});
const messageBox = user.findExportByName('MessageBoxW');
if(messageBox) Interceptor.attach(messageBox, {onEnter(args) {send({messageBox:string(args[1])});}});
Interceptor.attach(kernel.getExportByName('GetCommandLineW'), {onLeave(result) {send({commandLine:string(result)});}});
Interceptor.attach(kernel.getExportByName('CreateProcessW'), {onEnter(args) {send({spawn:string(args[1])});}});
"""
def instrument(process_id):
    session = device.attach(process_id)
    sessions[process_id] = session
    def detached(*args):
        print({'detached': process_id, 'reason': str(args)}, flush=True)
        sessions.pop(process_id, None)
    session.on('detached', detached)
    session.enable_child_gating()
    script = session.create_script(source)
    script.on('message', lambda message, data: print({'pid': process_id, **message}, flush=True))
    script.load()

def child_added(child):
    print({'child': child.pid, 'parent': child.parent_pid}, flush=True)
    instrument(child.pid)
    device.resume(child.pid)

device.on('child-added', child_added)
instrument(pid)
device.resume(pid)
started = time.monotonic()
while time.monotonic() - started < 45:
    if not sessions and time.monotonic() - started > 2:
        break
    time.sleep(0.1)
if sessions:
    for process_id in list(sessions):
        device.kill(process_id)
    raise RuntimeError('Trace timed out')
print('Disposable uninstaller trace completed', flush=True)
