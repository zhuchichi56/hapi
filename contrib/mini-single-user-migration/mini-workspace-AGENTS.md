# WWX on Mac mini

- WWX is a project; local commands run as `zhuhe` with `HOME=/Users/zhuhe`. Do not recreate the retired `hapi-wwx` macOS account.
- Meituan H20 access was verified through an actual HAPI model/tool turn on 2026-10-30. Use the installed SSH aliases directly:
  - `ssh 8h20-3 '<command>'` (also `h20-3`)
  - `ssh 8h20-4 '<command>'` (also `h20-4`)
- Both connect as the existing `hadoop-aipnlp` user. The verified read-only check returned eight H20 GPUs on each machine. This is connection evidence, not a claim that GPUs are free.
- The current configuration is `/Users/zhuhe/.ssh/config`. SSH uses a Mini-local dedicated key and verified host keys with strict checking. Do not print private keys, credentials or private endpoints. Archived instructions about missing keys or `node-ssh -> mbp-mt` describe the pre-repair setup; that wrapper is not needed here.
- Connectivity check: `ssh -S none -o BatchMode=yes -o ConnectTimeout=8 8h20-3 'id -un; nvidia-smi --query-gpu=name --format=csv,noheader'` (replace with `8h20-4` for the other machine). SSH returns the remote command's exit code.
- Other existing projects may schedule only on H20-3/4 after checking current ownership, active jobs and persistent storage. H20-1/2 belong to another project. Do not start, stop, resume or alter any GPU job merely to test access. Previously paused tasks stay paused.
- GPU work must use the machine's existing `~/.local/h20-shepherd/h20-shepherd run -- <command>` entry and the project's approved experiment settings. Read-only `nvidia-smi` does not allocate GPU work.
- Mini still uses the current MacBook/Thunderbolt network path. This repair does not establish standalone Mini networking. If a CodeLab Pod is rebuilt, obtain its current endpoint and authenticated host key before updating the target alias; do not guess old addresses or disable host-key checks.
