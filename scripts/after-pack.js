// Al compilar para Windows desde Linux/macOS sin Wine, electron-builder no
// puede editar el .exe. Este paso pone el icono y los datos de versión con
// resedit (JavaScript puro). En Windows lo hace el propio electron-builder.
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const ResEdit = require('resedit');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') return adHocSign(context);
  if (context.electronPlatformName !== 'win32' || process.platform === 'win32') return;

  const { appInfo } = context.packager;
  const exePath = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
  const icoPath = path.join(__dirname, '..', 'assets', 'icon.ico');

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  // Icono
  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
  const group = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)[0];
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    group ? group.id : 1,
    group ? group.lang : 1033,
    icon.icons.map((i) => i.data),
  );

  // Datos de versión que muestra Windows (Propiedades → Detalles, Administrador de tareas)
  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const [maj, min, pat] = appInfo.version.split('.').map((n) => parseInt(n, 10) || 0);
  const lang = { lang: 1033, codepage: 1200 };
  vi.removeStringValue(lang, 'SquirrelAwareVersion');
  vi.setStringValues(lang, {
    ProductName: appInfo.productName,
    FileDescription: appInfo.productName,
    CompanyName: appInfo.companyName || appInfo.productName,
    LegalCopyright: appInfo.copyright,
    InternalName: appInfo.productFilename,
    OriginalFilename: `${appInfo.productFilename}.exe`,
  });
  vi.setFileVersion(maj, min, pat, 0, 1033);
  vi.setProductVersion(maj, min, pat, 0, 1033);
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`  • icono y versión aplicados a ${path.basename(exePath)}`);
};

// Firma ad-hoc en macOS: sin ella, en Mac con chip Apple la app aparece como
// "dañada". (Para distribuir sin avisos hace falta un certificado de Apple.)
function adHocSign(context) {
  if (process.platform !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log(`  • firma ad-hoc aplicada a ${path.basename(app)}`);
}
