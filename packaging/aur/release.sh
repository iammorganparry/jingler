#!/usr/bin/env bash
# Publish a Jingler release to the AUR by repackaging its x86_64 AppImage.
#
#   packaging/aur/release.sh <version> <stable|nightly>
#
# Runs inside an archlinux:base-devel container as a non-root user with
# AUR_SSH_PRIVATE_KEY in the environment. Stable publishes `jingler-bin`,
# nightly publishes `jingler-nightly-bin` (conflicting, so only one installs).
set -euo pipefail

VERSION="$1"
CHANNEL="$2"
REPO="${GITHUB_REPOSITORY:-iammorganparry/jingler}"
case "$CHANNEL" in
  stable) PKGNAME=jingler-bin; CONFLICTS=jingler-nightly-bin ;;
  nightly) PKGNAME=jingler-nightly-bin; CONFLICTS=jingler-bin ;;
  *) echo "unknown channel: $CHANNEL" >&2; exit 2 ;;
esac

ASSET="Jingler-${VERSION}-x86_64.AppImage"
URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ASSET}"
# pkgver may not contain '-'; nightly versions carry `-nightly.<date>.<run>`.
PKGVER="${VERSION//-/_}"

WORK="$(mktemp -d)"
curl -fsSL "$URL" -o "$WORK/$ASSET"
SHA256="$(sha256sum "$WORK/$ASSET" | cut -d' ' -f1)"

mkdir -p ~/.ssh
printf '%s\n' "$AUR_SSH_PRIVATE_KEY" > ~/.ssh/aur
chmod 600 ~/.ssh/aur
printf 'Host aur.archlinux.org\n  IdentityFile ~/.ssh/aur\n  User aur\n' > ~/.ssh/config
ssh-keyscan -t ed25519 aur.archlinux.org >> ~/.ssh/known_hosts 2>/dev/null

git clone "ssh://aur@aur.archlinux.org/${PKGNAME}.git" "$WORK/aur"
cd "$WORK/aur"

cat > PKGBUILD <<EOF
# Maintainer: Jingler <https://github.com/${REPO}>
pkgname=${PKGNAME}
pkgver=${PKGVER}
pkgrel=1
pkgdesc="Desktop agent harness for coding CLIs"
arch=('x86_64')
url="https://github.com/${REPO}"
license=('custom')
depends=('fuse2')
provides=('jingler')
conflicts=('${CONFLICTS}')
options=('!strip' '!debug')
source=("${ASSET}::${URL}")
sha256sums=('${SHA256}')

prepare() {
  chmod +x "${ASSET}"
  ./"${ASSET}" --appimage-extract >/dev/null
}

package() {
  install -Dm755 "${ASSET}" "\${pkgdir}/opt/jingler/Jingler.AppImage"
  install -dm755 "\${pkgdir}/usr/bin"
  ln -s /opt/jingler/Jingler.AppImage "\${pkgdir}/usr/bin/jingler"
  install -Dm644 squashfs-root/.DirIcon "\${pkgdir}/usr/share/icons/hicolor/512x512/apps/jingler.png"
  install -Dm644 /dev/stdin "\${pkgdir}/usr/share/applications/jingler.desktop" <<DESKTOP
[Desktop Entry]
Name=Jingler
Exec=/usr/bin/jingler %U
Icon=jingler
Type=Application
Categories=Development;
MimeType=x-scheme-handler/jingler;
DESKTOP
}
EOF

namcap PKGBUILD || true
makepkg --printsrcinfo > .SRCINFO
makepkg --nodeps --noconfirm --cleanbuild >/dev/null

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add PKGBUILD .SRCINFO
if git diff --cached --quiet; then
  echo "AUR ${PKGNAME} already at ${VERSION}"
  exit 0
fi
git commit -m "Update to ${VERSION}"
git push origin HEAD:master
echo "Published ${PKGNAME} ${VERSION} to the AUR"
