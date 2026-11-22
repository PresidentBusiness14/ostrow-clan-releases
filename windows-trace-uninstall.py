"""Trace only the disposable CI app's old uninstaller, never a user computer."""
import os
import pathlib
import shutil
import tempfile
import threading
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
session = device.attach(pid)
finished = threading.Event()
session.on('detached', lambda *args: finished.set())
script = session.create_script(r"""
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
""")
script.on('message', lambda message, data: print(message, flush=True))
script.load()
device.resume(pid)
if not finished.wait(45):
    device.kill(pid)
    raise RuntimeError('Trace timed out')
print('Disposable uninstaller trace completed', flush=True)
