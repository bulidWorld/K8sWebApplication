set +e
printf '\n=== kubelet / containerd 服务状态 ===\n'
systemctl --no-pager --full status kubelet containerd 2>&1
printf '\n=== kubelet / containerd 近期日志 ===\n'
journalctl --no-pager -u kubelet -u containerd -n 80 -o short-iso 2>&1
printf '\n=== apt 近期安装日志 ===\n'
if [ -r /var/log/apt/term.log ]; then tail -n 60 /var/log/apt/term.log; fi
exit 0
