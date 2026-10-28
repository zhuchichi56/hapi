#!/bin/sh
set -eu
umask 077
tool=/Users/zhuhe/.local/lib/hapi-mini/single-user-migration-20261028/tool
bun=/opt/hapi-wwx/bin/bun
"$bun" "$tool/migrate-single-user.mjs" --check
printf '\n需要输入 Mac mini 的 zhuhe 登录密码。密码只交给系统 sudo，不会显示或保存。\n'
sudo "$bun" "$tool/migrate-single-user.mjs" --apply
printf '\n正在用新测试会话核验模型回复、写文件、联网和恢复旧会话，通常需要几分钟。\n'
if ! "$bun" "$tool/accept-live.mjs" --run; then
    printf '\n实际会话验收未通过，旧用户尚未删除，完整备份已保留。请把此窗口的错误交给当前聊天继续处理。\n' >&2
    exit 1
fi
migration_backup=$(
    "$bun" -e 'const r=await Bun.file("/Users/zhuhe/.local/lib/hapi-mini/projects/wwx/migration-receipt.json").json(); if(!r.backupDir?.startsWith("/var/root/hapi-wwx-migration/"))throw Error("Invalid migration receipt");console.log(r.backupDir)'
)
sudo "$bun" "$tool/migrate-single-user.mjs" --finalize "$migration_backup"
if /usr/bin/id hapi-wwx >/dev/null 2>&1; then
    printf '旧用户仍存在，请继续检查。\n' >&2
    exit 1
fi
printf '\n迁移完成：WWX 服务使用 zhuhe；旧 hapi-wwx 系统用户已删除。原目录和完整备份均保留。\n'
