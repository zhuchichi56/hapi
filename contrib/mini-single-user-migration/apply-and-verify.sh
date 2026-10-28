#!/bin/sh
set -eu
umask 077
tool=/Users/zhuhe/.local/lib/hapi-mini/single-user-migration-20261028/tool
bun=/opt/hapi-wwx/bin/bun
receipt=/Users/zhuhe/.local/lib/hapi-mini/projects/wwx/migration-receipt.json
case "${1:-}" in
    '') finalize_only=false ;;
    --finalize-only) finalize_only=true ;;
    *) printf 'Usage: apply-and-verify.sh [--finalize-only]\n' >&2; exit 64 ;;
esac
if [ ! -f "$receipt" ]; then
    if [ "$finalize_only" = true ]; then
        printf '迁移记录不存在，不能执行收尾。\n' >&2
        exit 1
    fi
    "$bun" "$tool/migrate-single-user.mjs" --check >/dev/null
    printf '准备迁移 WWX 到 zhuhe：备份项目、HAPI 和 Agent 状态；原 Library 等系统资料目录整体保留在原处。\n'
    printf '\n需要输入 Mac mini 的 zhuhe 登录密码。密码只交给系统 sudo，不会显示或保存。\n'
    sudo "$bun" "$tool/migrate-single-user.mjs" --apply
else
    printf '已检测到迁移完成记录，继续收尾。\n'
fi
migration_backup=$(
    "$bun" -e 'const r=await Bun.file("/Users/zhuhe/.local/lib/hapi-mini/projects/wwx/migration-receipt.json").json(); if(!/^\/var\/root\/hapi-wwx-migration\/\d{8}T\d{6}Z$/.test(r.backupDir)||!Number.isFinite(Date.parse(r.appliedAt)))throw Error("Invalid migration receipt");console.log(r.backupDir)'
)
if [ "$finalize_only" = false ]; then
    printf '\n正在核验模型回复、写文件、联网和恢复旧会话，通常需要几分钟。\n'
    if ! "$bun" "$tool/accept-live.mjs" --run; then
        printf '\n实际会话验收未通过，旧用户尚未删除，项目备份和原目录已保留。请把此窗口的错误交给当前聊天继续处理。\n' >&2
        exit 1
    fi
fi
printf '\n实际验收记录由收尾脚本再次核对。若 sudo 提示 Password，请输入 Mac mini 的 zhuhe 登录密码。\n'
sudo "$bun" "$tool/migrate-single-user.mjs" --finalize "$migration_backup"
if /usr/bin/id hapi-wwx >/dev/null 2>&1; then
    printf '旧用户仍存在，请继续检查。\n' >&2
    exit 1
fi
printf '\n迁移完成：WWX 服务使用 zhuhe；旧 hapi-wwx 系统用户已删除。项目备份和原系统资料目录均保留。\n'
