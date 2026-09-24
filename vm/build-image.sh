#!/bin/bash
set -e
IMG="virium-base.qcow2"
MNT="/mnt/virium-root"

echo "Creating 2GB qcow2 disk image..."
qemu-img create -f qcow2 "$IMG" 2G
mkfs.ext4 -F "$IMG"

mkdir -p "$MNT"
guestmount -a "$IMG" -m /dev/sda "$MNT"

echo "Downloading Alpine Linux mini rootfs..."
curl -sL https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-3.20.0-x86_64.tar.gz | tar -xz -C "$MNT"

echo "Installing Chromium, Xvfb, and dependencies into chroot..."
chroot "$MNT" /bin/sh -c "
  apk update &&
  apk add --no-cache chromium xvfb font-noto mesa-gl
"

echo "Copying guest init script..."
cp ./vm/init "$MNT/init"
chmod +x "$MNT/init"

guestunmount "$MNT"
echo "VM Image built successfully: $IMG"
