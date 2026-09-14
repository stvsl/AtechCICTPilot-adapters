"""Query VCarEA connector service configuration via KY.VCar.Central.Connector.Sdk."""

from __future__ import annotations

import argparse
import sys

import sdk_loader


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="查询 VCarEA 宿主已创建的 MQTT 连接服务配置（只读）。"
    )
    parser.add_argument(
        "key",
        nargs="?",
        default="VCarEA",
        help="连接服务唯一标识，默认 VCarEA，如果需要查询执行器服务，则使用 VCarEA.Executor",
        choices=["VCarEA", "VCarEA.Executor"],
    )
    parser.add_argument(
        "--bin-dir",
        help="包含 KY.VCar.Central.Connector.Sdk.dll 的应用程序 bin 目录",
    )
    return parser


def print_connection_info(info) -> None:
    print("=== ConnectorConnectionInfo ===")
    print(f"  ClientName      : {info.ClientName}")
    print(f"  Host            : {info.Host}")
    print(f"  Port            : {info.Port}")
    print(f"  UserName        : {info.UserName}")
    print(f"  Password        : {info.Password}")
    print(f"  TimeoutSeconds  : {info.TimeoutSeconds}")
    print(f"  KeepAliveSeconds: {info.KeepAliveSeconds}")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    sdk_loader.load_sdk(args.bin_dir)

    client = None
    try:
        client = sdk_loader.ConnectorServiceClient.Connect()
        info = client.TryGetConnectionInfo(args.key)

        if info is None:
            print(f"连接服务 [{args.key}] 尚未创建，返回 null。")
            print("请确认宿主进程已通过 ReadOrCreateConnectorService 创建该 key。")
            return 2

        print_connection_info(info)
        return 0
    except sdk_loader.CentralServiceException as ex:
        print(ex.Message, file=sys.stderr)
        return 1
    finally:
        if client is not None:
            client.Dispose()


if __name__ == "__main__":
    raise SystemExit(main())
