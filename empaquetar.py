#!/usr/bin/env python3
"""Arma el .vsix sin node ni vsce: un zip con [Content_Types].xml,
extension.vsixmanifest y la carpeta extension/."""
import json
import os
import zipfile
from xml.sax.saxutils import escape

RAIZ = os.path.dirname(os.path.abspath(__file__))
ARCHIVOS = ["package.json", "extension.js", "monitor.js", "costos.js", "rutina.js", "alarmas.js", "vista.js", "consumo.js", "anthropic.js", "pomodoro.js", "configurar.js", "idioma.js", "l10n/en.json", "package.nls.json", "package.nls.es.json", "README.md", "CHANGELOG.md", "LICENSE", "media/koala.js", "media/panel.js", "media/icono.png",
            "scripts/koala-statusline.py", "scripts/koala-hook.py"]

pkg = json.load(open(os.path.join(RAIZ, "package.json"), encoding="utf-8"))
salida = os.path.join(RAIZ, f"{pkg['name']}-{pkg['version']}.vsix")

tipos = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".py" ContentType="text/x-python"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Default Extension=".txt" ContentType="text/plain"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
"""

manifiesto = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="es-MX" Id="{pkg['name']}" Version="{pkg['version']}" Publisher="{pkg['publisher']}"/>
    <DisplayName>{escape(pkg['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(pkg['description'])}</Description>
    <Categories>Other,Visualization</Categories>
    <Icon>extension/media/icono.png</Icon>
    <License>extension/LICENSE.txt</License>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{pkg['engines']['vscode']}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icono.png" Addressable="true"/>
  </Assets>
</PackageManifest>
"""

with zipfile.ZipFile(salida, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", tipos)
    z.writestr("extension.vsixmanifest", manifiesto)
    for rel in ARCHIVOS:
        destino = "LICENSE.txt" if rel == "LICENSE" else rel
        info = zipfile.ZipInfo.from_file(os.path.join(RAIZ, rel), "extension/" + destino)
        with open(os.path.join(RAIZ, rel), "rb") as f:
            z.writestr(info, f.read(), zipfile.ZIP_DEFLATED)
print(salida)
