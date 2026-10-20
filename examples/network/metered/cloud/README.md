# Measuring large networks: the DSO on up to 43 participants

Locally the DSO series stops at 8 hosts. This directory measures it on up to
43 participants, on one rented machine, in one command. (MainNet's DSO has 13
Super Validator nodes as of 2026-10-20; earlier versions of this page said 43,
which was wrong. 13 hosts fit on a desktop with the local eight-node setup
extended; this directory is for going past MainNet's size.)

It is still your own private network (one sequencer, one mediator, N
participants, in memory). Nothing touches DevNet, TestNet or MainNet, so no
permission is needed.

## 1. The machine

- **Memory:** about 0.6 GB of Java heap per participant, plus headroom. For 43
  participants: **64 GB RAM** (the script sets `-Xmx28g` by default for N=43;
  override with `HEAP`).
- **CPU:** 8-16 vCPUs. More only makes booting faster.
- **Disk:** 20 GB is plenty (everything is in memory).
- **OS:** any recent 64-bit Linux (Ubuntu 22.04 or 24.04 tested commands below).
- **Cost:** large cloud machines bill by the hour; a full run is a few hours.
  Delete the machine afterwards.

## 2. Install the prerequisites

```bash
sudo apt-get update
sudo apt-get install -y openjdk-21-jre-headless git curl
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
java -version && node --version     # need Java 21 and Node >= 23.6
```

## 3. Copy over the code, the Canton jar and the Amulet DAR

The simplest way to get exactly the Canton version used for every local
measurement is to copy the jar that ships with Daml SDK 3.4.11. From your own
machine (PowerShell; replace USER and HOST):

```powershell
scp "$env:APPDATA\daml\sdk\3.4.11\canton\canton.jar" USER@HOST:~/canton.jar
scp "<path to>\splice-amulet-0.1.23.dar" USER@HOST:~/splice-amulet-0.1.23.dar
```

The Amulet DAR can also be downloaded on the machine:

```bash
curl -fL -o ~/splice-amulet-0.1.23.dar \
  https://raw.githubusercontent.com/canton-network/splice/main/daml/dars/splice-amulet-0.1.23.dar
```

Then the repository:

```bash
git clone https://github.com/fronow/Canton-Stress-Test.git
cd Canton-Stress-Test
```

## 4. Run

```bash
cd examples/network/metered/cloud
N=43 KS="1 8 16 24 32 43" OPS=30 \
  CANTON_JAR=~/canton.jar AMULET_DAR=~/splice-amulet-0.1.23.dar \
  bash run-scale.sh
```

What it does, in order:

1. `gen-network.cjs 43` writes `participants-43.conf` and `remote-43.conf`.
2. Boots that network with `bootstrap-metered.canton` (traffic control on,
   every node funded) and waits for `STRESSNET READY (METERED)`.
3. Uploads the Amulet DAR to all 43 participants.
4. For each K in `KS`: creates a DSO party hosted on the first K participants
   (threshold 1, see METERED.md), then measures `OPS` Amulet transfers with it
   and reads what the sequencer billed every node.

Each K is a separate measurement with its own result file, so a run that stops
part way (for example memory at K=43) still yields every K before it. Expect
booting to take several minutes and each K a few minutes more than the last.

## 5. Bring the results back

```powershell
scp "USER@HOST:~/Canton-Stress-Test/examples/network/metered/results/table-amulet-dso-*" `
  "<your clone>\examples\network\metered\results\"
```

Then compare with the line fitted locally (PREDICTIONS.md, round 3): submitter
4,616 + 233.3 × (K − 1) B, all participants 4,552 + 635.5 × (K − 1) B. Write
the predictions for the K values you run into PREDICTIONS.md **before**
starting the run, as for every earlier round.

## If something goes wrong

- **Boot never reaches READY:** look at `canton-43.log` here. Out of memory:
  raise `HEAP` (and the machine's RAM).
- **A K fails with "The server was not able to produce a timely response":**
  confirmations from many hosts missed Canton's default 30 s deadline (on 8
  vCPUs this happened at 32 hosts). Keep the network running (`KEEP=1`),
  raise the deadlines with
  `java -jar ~/canton.jar run raise-timeouts.canton -c ../../remote-43.conf`
  (from this directory), then re-run that K alone with
  `run-dso-series.sh` (see the measured run's notes in PREDICTIONS.md, round 6).
- **Do not press Ctrl+C in the run's window.** To leave it running inside
  tmux, press Ctrl+B and then D.
- **A K fails to create its DSO party:** the console output is in the run's
  terminal; the most likely cause is a timeout while 43 participants sign the
  hosting proposal. Re-run that K alone with `KS="<K>"`.
- **Stop the network:** `pkill -f participants-43.conf`.

The same script was tested end to end on 4 participants (`N=4 KS="1 4"`) on a
laptop; at 43 participants only the size is new.
