# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all

# kiwipiepy(형태소 분석)는 네이티브 모듈 + 사전 데이터가 함께 있어야 작동
_kiwi_datas, _kiwi_bins, _kiwi_hidden = [], [], []
for _pkg in ("kiwipiepy", "kiwipiepy_model"):
    d, b, h = collect_all(_pkg)
    _kiwi_datas += d; _kiwi_bins += b; _kiwi_hidden += h

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=_kiwi_bins,
    datas=_kiwi_datas,
    hiddenimports=['psutil'] + _kiwi_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='app',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='app',
)
