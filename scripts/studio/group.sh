#!/bin/bash
# 三个独立 group：每个只跑一件事，各自 pid / 日志 / 状态文件，互不托管
# 用法: scripts/studio/group.sh start|stop|restart|status score|risk|copy|kol|all
cd "$(dirname "$0")/../.." || exit 1
D=data/studio; mkdir -p $D
bot(){ case $1 in score) echo market-bot.js;; risk) echo risk-bot.js;; copy) echo copy-bot.js;; kol) echo ../kol-news-sniper.js;; esac; }
alive(){ [ -f $D/$1.pid ] && kill -0 "$(cat $D/$1.pid)" 2>/dev/null; }
start(){ if alive $1; then echo "$1 已在运行 pid $(cat $D/$1.pid)"; return; fi
  nohup node scripts/studio/$(bot $1) >> $D/$1.log 2>&1 & echo $! > $D/$1.pid; echo "$1 启动 pid $!"; }
stop(){ alive $1 && kill "$(cat $D/$1.pid)" && echo "$1 已停止"; rm -f $D/$1.pid; }
status(){ alive $1 && echo "$1 在线 pid $(cat $D/$1.pid)" || echo "$1 离线"; }
G=${2:-all}; [ "$G" = all ] && G="score risk copy"
for g in $G; do case $1 in start) start $g;; stop) stop $g;; restart) stop $g; sleep 1; start $g;; status) status $g;; *) echo "用法: $0 start|stop|restart|status score|risk|copy|kol|all"; exit 1;; esac; done
