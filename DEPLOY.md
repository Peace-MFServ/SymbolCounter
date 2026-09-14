# Putting Door Schedules on a server (Google Cloud)

One small always-on VM runs the whole app. About 10 euro a month.
Everything that must survive lives in the `data` folder on the VM.

## 1. Create the VM (from your PC, in the gcloud terminal)

Pick your project first: `gcloud config set project YOUR_PROJECT_ID`

```
gcloud services enable compute.googleapis.com

gcloud compute instances create door-schedules ^
  --zone=europe-west1-b --machine-type=e2-small ^
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud ^
  --boot-disk-size=20GB --tags=door-schedules

gcloud compute firewall-rules create door-schedules-web ^
  --allow=tcp:80,tcp:443 --target-tags=door-schedules
```

(`^` is the PowerShell line-continuation. On one line, drop the `^`s.)

Get the server's address. Write it down, you need it twice:

```
gcloud compute instances describe door-schedules --zone=europe-west1-b --format="get(networkInterfaces[0].accessConfigs[0].natIP)"
```

## 2. Log in to the VM

```
gcloud compute ssh door-schedules --zone=europe-west1-b
```

Everything from here runs on the VM.

## 3. Install Docker and get the code

```
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER
newgrp docker

git clone https://github.com/Peace-MFServ/SymbolCounter.git
cd SymbolCounter
git checkout peace
```

If git asks for a password, use a GitHub personal access token, not your GitHub password.

## 4. Settings

```
cp .env.example .env
nano .env
```

Fill in the three lines:

- `SITE_ADDRESS=` the address from step 1 followed by `.nip.io`, e.g. `34.12.34.56.nip.io`
- `SECRET_KEY=` a long random string. Make one with `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`
- `REGISTER_CODE=` a word people must type to create an account, e.g. `mfdoors`

Ctrl+O, Enter, Ctrl+X to save and leave nano.

## 5. The logo (optional)

From your PC, in a second gcloud terminal:

```
gcloud compute scp "C:\Users\Zak Osman\Desktop\SymbolCounter2\backend\assets\logo.png" door-schedules:~/SymbolCounter/logo.png --zone=europe-west1-b
```

Then on the VM: `mkdir -p data/assets && mv logo.png data/assets/`

## 6. Start it

```
docker compose up -d --build
```

First build takes a few minutes. Then open `https://<address>.nip.io` in a browser.
The first visit can take 30 seconds while the HTTPS certificate is issued.

Create your account with the invite code, then send people the address and the code.

## Updating after a push

On the VM:

```
cd ~/SymbolCounter && git pull && docker compose up -d --build
```

## Useful

- Logs: `docker compose logs -f app`
- Restart: `docker compose restart`
- Backup: copy the `data` folder. From your PC:
  `gcloud compute scp --recurse door-schedules:~/SymbolCounter/data ./door-schedules-backup --zone=europe-west1-b`
- Stop paying: `gcloud compute instances delete door-schedules --zone=europe-west1-b`
