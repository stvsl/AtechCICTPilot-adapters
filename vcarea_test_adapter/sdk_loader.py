"""Load KY.VCar.Central.Connector.Sdk via pythonnet."""

from __future__ import annotations

import os
import sys
from pathlib import Path

_SDK_LOADED = False
ConnectorServiceClient = None
ConnectorServiceOptions = None
CentralServiceException = None

_ENV_VAR_NAME = "VCAREA_CONNECTOR_BIN_PATH"
_SITE_PACKAGES_ENV_VAR = "VCAREA_PYTHON_SITE_PACKAGES"
_SDK_DLL_NAME = "KY.VCar.Central.Connector.Sdk.dll"
# VCarEA 子目录（如 CentralServices）仅部署中心服务(net8.0)，不含 Connector SDK
_KNOWN_SUBDIRS_WITHOUT_SDK = frozenset({"centralservices", "drivers", "executor"})


def _has_sdk(path: Path) -> bool:
    return (path / _SDK_DLL_NAME).is_file()


def resolve_sdk_bin_dir(preferred: Path | None = None) -> Path:
    """解析含 KY.VCar.Central.Connector.Sdk.dll 的目录；子目录不含 SDK 时回退到宿主根 bin。"""
    if preferred is None:
        env_path = os.environ.get(_ENV_VAR_NAME)
        if env_path:
            preferred = Path(env_path)
        else:
            script_dir = Path(__file__).resolve().parent
            sample_root = script_dir / ".." / "KY.VCar.Central.Connector.Sdk.Sample" / "bin"
            for config in ("Release", "Debug"):
                candidate = (sample_root / config / "net8.0").resolve()
                if candidate.is_dir() and _has_sdk(candidate):
                    return candidate
            raise FileNotFoundError(
                "未找到 Connector SDK 程序集目录。请先构建 KY.VCar.Central.Connector.Sdk.Sample，"
                f"或设置 {_ENV_VAR_NAME} 指向包含 {_SDK_DLL_NAME} 的应用程序 bin 目录。"
            )

    root = preferred.resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"bin 目录不存在: {root}")

    if _has_sdk(root):
        return root

    for parent in root.parents:
        if _has_sdk(parent):
            print(
                f"[sdk_loader] 警告: {root} 不含 {_SDK_DLL_NAME}，"
                f"已自动回退至 {parent}。"
                f"（CentralServices 是中心服务进程目录，不是 SDK 目录）",
                file=sys.stderr,
            )
            return parent

    raise FileNotFoundError(
        f"未找到 {_SDK_DLL_NAME}。请指定 VCarEA 根 bin 目录，例如 "
        f"...\\VCarEA\\bin\\Debug\\netcoreapp3.1，而非 CentralServices 子目录。"
    )


def resolve_bin_dir() -> Path:
    return resolve_sdk_bin_dir()


def _is_pythonnet_site_packages(path: Path) -> bool:
    return path.is_dir() and (
        (path / "pythonnet").is_dir() or (path / "clr.py").is_file()
    )


def _register_site_packages(path: Path) -> None:
    path_str = str(path.resolve())
    if path_str not in sys.path:
        sys.path.insert(0, path_str)


def resolve_site_packages(bin_dir: Path) -> Path:
    env_path = os.environ.get(_SITE_PACKAGES_ENV_VAR)
    if env_path:
        root = Path(env_path).resolve()
        if _is_pythonnet_site_packages(root):
            return root
        raise FileNotFoundError(
            f"{_SITE_PACKAGES_ENV_VAR} 指向的目录不存在或未包含 pythonnet: {root}"
        )

    for parent in (bin_dir, *bin_dir.parents):
        candidate = parent / "site-packages"
        if _is_pythonnet_site_packages(candidate):
            return candidate.resolve()

    script_dir = Path(__file__).resolve().parent
    dev_candidate = (script_dir / ".." / ".." / ".." / "Steps" / "site-packages").resolve()
    if _is_pythonnet_site_packages(dev_candidate):
        return dev_candidate

    raise FileNotFoundError(
        "未找到 pythonnet。请确认应用程序安装目录下存在 site-packages，"
        f"或设置 {_SITE_PACKAGES_ENV_VAR}。"
    )


def _ensure_pythonnet_path(bin_dir: Path) -> None:
    _register_site_packages(resolve_site_packages(bin_dir))


def _configure_coreclr_runtime(bin_dir: Path) -> None:
    """Autotest/VCarEA 需用 coreclr + runtimeconfig，否则 pythonnet 默认 netfx 无法加载 netcoreapp3.1 程序集。"""
    if os.environ.get("PYTHONNET_RUNTIME"):
        return

    for parent in (bin_dir, *bin_dir.parents):
        for name in (
            "VCarEA.runtimeconfig.json",
            "KY.VCar.Central.Connector.Sdk.Sample.runtimeconfig.json",
        ):
            config = parent / name
            if config.is_file():
                os.environ["PYTHONNET_RUNTIME"] = "coreclr"
                os.environ.setdefault(
                    "PYTHONNET_CORECLR_RUNTIME_CONFIG", str(config.resolve())
                )
                return


def _register_native_search_path(path: Path) -> None:
    path_str = str(path.resolve())
    if path_str not in sys.path:
        sys.path.append(path_str)

    if hasattr(os, "add_dll_directory"):
        os.add_dll_directory(path_str)


def _register_assembly_resolve(bin_dir: Path) -> None:
    """Ensure managed dependencies resolve from bin_dir, not GAC or other probing paths."""
    from System import AppDomain
    from System.Reflection import Assembly, AssemblyName

    resolved = bin_dir.resolve()

    def _resolve_handler(_sender, args):
        try:
            simple_name = AssemblyName(args.Name).Name
            candidate = resolved / f"{simple_name}.dll"
            if candidate.is_file():
                return Assembly.LoadFrom(str(candidate))
        except Exception:
            pass
        return None

    AppDomain.CurrentDomain.AssemblyResolve += _resolve_handler


def _preload_assemblies(bin_dir: Path) -> None:
    """Load MQTTnet and Mqtts from bin_dir before SDK triggers dependency resolution."""
    from System.Reflection import Assembly

    resolved = bin_dir.resolve()
    for name in ("MQTTnet.dll", "KY.VCar.Topic.Communications.Mqtts.dll"):
        path = resolved / name
        if path.is_file():
            Assembly.LoadFrom(str(path))


def load_sdk(bin_dir: Path | str | None = None) -> None:
    global _SDK_LOADED
    global ConnectorServiceClient
    global ConnectorServiceOptions
    global CentralServiceException

    if _SDK_LOADED:
        return

    root = resolve_sdk_bin_dir(Path(bin_dir).resolve() if bin_dir else None)
    _configure_coreclr_runtime(root)
    _ensure_pythonnet_path(root)

    import clr

    sdk_dll = root / _SDK_DLL_NAME

    if not sdk_dll.is_file():
        raise FileNotFoundError(f"未找到 SDK 主程序集: {sdk_dll}")

    _register_native_search_path(root)
    _register_assembly_resolve(root)
    _preload_assemblies(root)

    clr.AddReference(str(sdk_dll))

    from KY.VCar.Central.Connector.Sdk import (
        CentralServiceException as _CentralServiceException,
        ConnectorServiceClient as _ConnectorServiceClient,
        ConnectorServiceOptions as _ConnectorServiceOptions,
    )

    ConnectorServiceClient = _ConnectorServiceClient
    ConnectorServiceOptions = _ConnectorServiceOptions
    CentralServiceException = _CentralServiceException
    _SDK_LOADED = True
