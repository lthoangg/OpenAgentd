.PHONY: dev ios-init ios-icons ios-icons-force ios-web ios-dev ios-dev-device ios-install-device ios-install-device-fast ios-ipa ios-release ios-build ios-clean android-init android-icons android-dev android-apk android-release android-install android-clean build clean

IOS_DEVICE ?= $(word 2,$(MAKECMDGOALS))
IOS_DEV_IDENTIFIER ?= com.dev.openagentd.mobile
IOS_DEV_PRODUCT_NAME ?= OpenAgentd Dev
IOS_DEV_APP_CONFIG = --config '{"identifier":"$(IOS_DEV_IDENTIFIER)","productName":"$(IOS_DEV_PRODUCT_NAME)","plugins":{"deep-link":{"mobile":[{"scheme":["openagentd-dev"],"appLink":false}]}}}'
IOS_APPICONSET = src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset
IOS_ICON_STAMP = $(IOS_APPICONSET)/.openagentd-icons.stamp
WEB_DIR = ../web
WEB_DIST_INDEX = $(WEB_DIR)/dist/index.html
WEB_BUILD_INPUTS = $(WEB_DIR)/index.html $(WEB_DIR)/package.json $(WEB_DIR)/bun.lock $(WEB_DIR)/tsconfig.json $(WEB_DIR)/tsconfig.app.json $(WEB_DIR)/tsconfig.node.json $(WEB_DIR)/vite.config.ts

# Android: Tauri needs JAVA_HOME (JDK 17+), ANDROID_HOME, and NDK_HOME. The
# SDK/NDK default to Android Studio's location and the newest installed NDK.
ANDROID_HOME ?= $(HOME)/Library/Android/sdk
NDK_HOME ?= $(lastword $(sort $(wildcard $(ANDROID_HOME)/ndk/*)))
export ANDROID_HOME NDK_HOME
# Rust ABIs in the release APK (aarch64 armv7 i686 x86_64). arm64 covers
# current phones and Apple-silicon emulators; add more for older devices.
ANDROID_TARGETS ?= aarch64
ANDROID_DEVICE ?= $(word 2,$(MAKECMDGOALS))
ANDROID_RES = src-tauri/gen/android/app/src/main/res

dev: ## Run the mobile shell against the web Vite dev server
	cd src-tauri && cargo tauri dev

ios-init: ## Initialize Tauri iOS project files
	cd src-tauri && cargo tauri ios init
	mkdir -p src-tauri/gen/apple && cp src-tauri/PrivacyInfo.xcprivacy src-tauri/gen/apple/PrivacyInfo.xcprivacy
	./scripts/patch-launch-screen.sh
	./scripts/patch-ios-widget.sh
	./scripts/patch-xcode-project.sh
	$(MAKE) ios-icons

$(IOS_ICON_STAMP): src-tauri/icons/icon.png
	python3 ../scripts/generate_icons.py
	@if [ -d src-tauri/icons/ios ]; then \
		mkdir -p $(IOS_APPICONSET); \
		cp src-tauri/icons/ios/*.png $(IOS_APPICONSET)/; \
		touch $(IOS_ICON_STAMP); \
	elif [ -d $(IOS_APPICONSET) ]; then \
		touch $(IOS_ICON_STAMP); \
	fi

ios-icons: $(IOS_ICON_STAMP) ## Generate iOS AppIcon assets when missing or stale

ios-icons-force: ## Force-regenerate iOS AppIcon assets from the shared OpenAgentd icon
	python3 ../scripts/generate_icons.py -f
	@if [ -d src-tauri/icons/ios ]; then \
		mkdir -p $(IOS_APPICONSET); \
		cp src-tauri/icons/ios/*.png $(IOS_APPICONSET)/; \
		touch $(IOS_ICON_STAMP); \
	elif [ -d $(IOS_APPICONSET) ]; then \
		touch $(IOS_ICON_STAMP); \
	fi

ios-web: ## Build bundled Web assets only when their inputs changed
	@needs_build=0; \
	if [ ! -f "$(WEB_DIST_INDEX)" ]; then \
		needs_build=1; \
	elif find $(WEB_DIR)/src $(WEB_DIR)/public -type f -newer "$(WEB_DIST_INDEX)" -print -quit | grep -q .; then \
		needs_build=1; \
	else \
		for input in $(WEB_BUILD_INPUTS); do \
			if [ "$$input" -nt "$(WEB_DIST_INDEX)" ]; then needs_build=1; break; fi; \
		done; \
	fi; \
	if [ "$$needs_build" -eq 1 ]; then \
		cd $(WEB_DIR) && bun install --frozen-lockfile && bun run build; \
	else \
		echo "Web bundle is current; skipping build"; \
	fi

ios-dev: ## Run on an iOS simulator/device
	./scripts/patch-ios-widget.sh
	./scripts/patch-xcode-project.sh
	cd src-tauri && cargo tauri ios dev --host

ios-dev-device: ## Run on a named physical iOS device, e.g. `make ios-dev-device DeviceName`
	@if [ -z "$(IOS_DEVICE)" ]; then \
		echo "Usage: make ios-dev-device <device-name>"; \
		exit 2; \
	fi
	IOS_APP_ID=$(IOS_DEV_IDENTIFIER) ./scripts/patch-ios-widget.sh
	./scripts/patch-xcode-project.sh
	cd src-tauri && cargo tauri ios dev --host $(IOS_DEV_APP_CONFIG) "$(IOS_DEVICE)"

ios-install-device: ## Build and install the production iOS app on a device
	@if [ -z "$(IOS_DEVICE)" ]; then \
		echo "Usage: make ios-install-device <device-name>"; \
		exit 2; \
	fi
	$(MAKE) ios-icons
	./scripts/patch-ios-widget.sh
	./scripts/patch-xcode-project.sh
	cd src-tauri && cargo tauri ios build --archive-only
	xcrun devicectl device install app --device "$(IOS_DEVICE)" src-tauri/gen/apple/build/openagentd-mobile_iOS.xcarchive/Products/Applications/OpenAgentd.app

ios-install-device-fast: ## Build and install a bundled debug iOS app on a device
	@if [ -z "$(IOS_DEVICE)" ]; then \
		echo "Usage: make ios-install-device-fast <device-name>"; \
		exit 2; \
	fi
	$(MAKE) ios-icons
	./scripts/patch-ios-widget.sh
	./scripts/patch-xcode-project.sh
	cd src-tauri && cargo tauri ios build --debug --archive-only
	xcrun devicectl device install app --device "$(IOS_DEVICE)" src-tauri/gen/apple/build/openagentd-mobile_iOS.xcarchive/Products/Applications/OpenAgentd.app

ios-ipa: ## Build the release archive and package a sideloadable IPA into dist/
	$(MAKE) ios-icons
	./scripts/patch-ios-widget.sh
	./scripts/patch-xcode-project.sh
	cd src-tauri && cargo tauri ios build --archive-only
	./scripts/package-ipa.sh

ios-release: ios-ipa ## Build the IPA and upload it plus source.json to the GitHub release (DRY_RUN=1 to preview)
	./scripts/publish-ipa.sh

%:
	@:

ios-build: ## Build the iOS app
	$(MAKE) ios-icons
	./scripts/patch-ios-widget.sh
	./scripts/patch-xcode-project.sh
	cd src-tauri && cargo tauri ios build

ios-clean: ## Remove generated iOS/Xcode state (keeps gen/android)
	rm -rf src-tauri/gen/apple ~/Library/Developer/Xcode/DerivedData/openagentd-mobile-*

android-init: ## Initialize Tauri Android (Gradle) project files
	cd src-tauri && cargo tauri android init --skip-targets-install
	./scripts/patch-android-theme.sh
	$(MAKE) android-icons

# The shared icon script writes the launcher icons (adaptive foreground on a
# #FAF6EC background) to src-tauri/icons/android/ from the brand masters.
android-icons: ## Generate OpenAgentd launcher icons into the Android project
	@[ -d $(ANDROID_RES) ] || { echo "Run 'make android-init' first"; exit 2; }
	python3 ../scripts/generate_icons.py
	cp -R src-tauri/icons/android/. $(ANDROID_RES)/

android-dev: ## Run on a connected Android device/emulator against Vite (`make android-dev [device]`)
	./scripts/patch-android-theme.sh
	cd src-tauri && cargo tauri android dev $(ANDROID_DEVICE) --host

android-apk: ## Build the release APK and sign it into dist/ (see scripts/package-apk.sh)
	@[ -d src-tauri/gen/android ] || $(MAKE) android-init
	./scripts/patch-android-theme.sh
	$(MAKE) android-icons
	cd src-tauri && cargo tauri android build --apk $(foreach t,$(ANDROID_TARGETS),--target $(t))
	./scripts/package-apk.sh

android-release: ## Build the release-signed APK and upload it to the GitHub release (DRY_RUN=1 to preview)
	@if [ "$(DRY_RUN)" != "1" ] && [ -z "$$ANDROID_KEYSTORE" ]; then \
		echo "android-release needs the release keystore: set ANDROID_KEYSTORE, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS"; \
		exit 2; \
	fi
	$(MAKE) android-apk
	./scripts/publish-apk.sh

android-install: ## Install dist/OpenAgentd_<version>_Android.apk on the connected device via adb
	adb install -r "dist/OpenAgentd_$$(../scripts/release_version.sh)_Android.apk"

android-clean: ## Remove generated Android/Gradle state
	rm -rf src-tauri/gen/android

build: ## Build the mobile Tauri app bundle
	cd src-tauri && cargo tauri build

clean: ## Remove mobile build artifacts
	rm -rf src-tauri/target src-tauri/gen src-tauri/ios
