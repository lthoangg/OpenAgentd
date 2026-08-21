.PHONY: dev ios-init ios-icons ios-icons-force ios-web ios-dev ios-dev-device ios-install-device ios-install-device-fast ios-build ios-clean build clean

IOS_DEVICE ?= $(word 2,$(MAKECMDGOALS))
IOS_TEAM_FILE ?= ios-team.txt
IOS_TEAM := $(shell test -f $(IOS_TEAM_FILE) && tr -d '[:space:]' < $(IOS_TEAM_FILE))
IOS_TEAM_CONFIG = $(if $(IOS_TEAM),--config '{"bundle":{"iOS":{"developmentTeam":"$(IOS_TEAM)"}}}')
IOS_DEV_IDENTIFIER ?= com.dev.openagentd.mobile
IOS_DEV_PRODUCT_NAME ?= OpenAgentd Dev
IOS_DEV_APP_CONFIG = --config '{"identifier":"$(IOS_DEV_IDENTIFIER)","productName":"$(IOS_DEV_PRODUCT_NAME)","plugins":{"deep-link":{"mobile":[{"scheme":["openagentd-dev"],"appLink":false}]}}}'
IOS_APPICONSET = src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset
IOS_ICON_STAMP = $(IOS_APPICONSET)/.openagentd-icons.stamp
WEB_DIR = ../web
WEB_DIST_INDEX = $(WEB_DIR)/dist/index.html
WEB_BUILD_INPUTS = $(WEB_DIR)/index.html $(WEB_DIR)/package.json $(WEB_DIR)/bun.lock $(WEB_DIR)/tsconfig.json $(WEB_DIR)/tsconfig.app.json $(WEB_DIR)/tsconfig.node.json $(WEB_DIR)/vite.config.ts

dev: ## Run the mobile shell against the web Vite dev server
	cd src-tauri && cargo tauri dev

ios-init: ## Initialize Tauri iOS project files
	cd src-tauri && cargo tauri ios init
	@if [ -n "$(IOS_TEAM)" ]; then \
		ruby -0pi -e 'gsub(/DEVELOPMENT_TEAM = "?[A-Z0-9]+"?;/, "DEVELOPMENT_TEAM = \"$(IOS_TEAM)\";")' src-tauri/gen/apple/openagentd-mobile.xcodeproj/project.pbxproj; \
	fi
	mkdir -p src-tauri/gen/apple && cp src-tauri/PrivacyInfo.xcprivacy src-tauri/gen/apple/PrivacyInfo.xcprivacy
	./scripts/patch-launch-screen.sh
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
	cd src-tauri && cargo tauri ios dev --host

ios-dev-device: ## Run on a named physical iOS device, e.g. `make ios-dev-device DeviceName`
	@if [ -z "$(IOS_DEVICE)" ]; then \
		echo "Usage: make ios-dev-device <device-name>"; \
		exit 2; \
	fi
	cd src-tauri && cargo tauri ios dev --host $(IOS_TEAM_CONFIG) $(IOS_DEV_APP_CONFIG) "$(IOS_DEVICE)"

ios-install-device: ## Build and install the production iOS app on a device
	@if [ -z "$(IOS_DEVICE)" ]; then \
		echo "Usage: make ios-install-device <device-name>"; \
		exit 2; \
	fi
	$(MAKE) ios-icons
	cd src-tauri && cargo tauri ios build --archive-only $(IOS_TEAM_CONFIG)
	xcrun devicectl device install app --device "$(IOS_DEVICE)" src-tauri/gen/apple/build/openagentd-mobile_iOS.xcarchive/Products/Applications/OpenAgentd.app

ios-install-device-fast: ## Build and install a bundled debug iOS app on a device
	@if [ -z "$(IOS_DEVICE)" ]; then \
		echo "Usage: make ios-install-device-fast <device-name>"; \
		exit 2; \
	fi
	$(MAKE) ios-icons
	cd src-tauri && cargo tauri ios build --debug --archive-only $(IOS_TEAM_CONFIG)
	xcrun devicectl device install app --device "$(IOS_DEVICE)" src-tauri/gen/apple/build/openagentd-mobile_iOS.xcarchive/Products/Applications/OpenAgentd.app

%:
	@:

ios-build: ## Build the iOS app
	$(MAKE) ios-icons
	cd src-tauri && cargo tauri ios build $(IOS_TEAM_CONFIG)

ios-clean: ## Remove generated iOS/Xcode state
	rm -rf src-tauri/gen ~/Library/Developer/Xcode/DerivedData/openagentd-mobile-*

build: ## Build the mobile Tauri app bundle
	cd src-tauri && cargo tauri build

clean: ## Remove mobile build artifacts
	rm -rf src-tauri/target src-tauri/gen src-tauri/ios
