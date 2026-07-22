.PHONY: dev ios-init ios-icons ios-icons-force ios-dev ios-dev-device ios-install-device ios-build ios-clean build clean

IOS_DEVICE ?= $(word 2,$(MAKECMDGOALS))
IOS_TEAM_FILE ?= ios-team.txt
IOS_TEAM := $(shell test -f $(IOS_TEAM_FILE) && tr -d '[:space:]' < $(IOS_TEAM_FILE))
IOS_TEAM_CONFIG = $(if $(IOS_TEAM),--config '{"bundle":{"iOS":{"developmentTeam":"$(IOS_TEAM)"}}}')
IOS_DEV_IDENTIFIER ?= com.dev.openagentd.mobile
IOS_DEV_PRODUCT_NAME ?= OpenAgentd Dev
IOS_DEV_APP_CONFIG = --config '{"identifier":"$(IOS_DEV_IDENTIFIER)","productName":"$(IOS_DEV_PRODUCT_NAME)","plugins":{"deep-link":{"mobile":[{"scheme":["openagentd-dev"],"appLink":false}]}}}'
IOS_APPICONSET = src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset
IOS_ICON_STAMP = $(IOS_APPICONSET)/.openagentd-icons.stamp

dev: ## Run the mobile shell against the web Vite dev server
	cd src-tauri && cargo tauri dev

ios-init: ## Initialize Tauri iOS project files
	cd src-tauri && cargo tauri ios init
	@if [ -n "$(IOS_TEAM)" ]; then \
		ruby -0pi -e 'gsub(/DEVELOPMENT_TEAM = "?[A-Z0-9]+"?;/, "DEVELOPMENT_TEAM = \"$(IOS_TEAM)\";")' src-tauri/gen/apple/openagentd-mobile.xcodeproj/project.pbxproj; \
	fi
	mkdir -p src-tauri/gen/apple && cp src-tauri/PrivacyInfo.xcprivacy src-tauri/gen/apple/PrivacyInfo.xcprivacy
	$(MAKE) ios-icons

$(IOS_ICON_STAMP): src-tauri/icons/icon.png
	python3 ../scripts/generate_icons.py
	@if [ -d src-tauri/icons/ios ]; then \
		mkdir -p $(IOS_APPICONSET); \
		cp src-tauri/icons/ios/*.png $(IOS_APPICONSET)/; \
		touch $(IOS_ICON_STAMP); \
	fi

ios-icons: $(IOS_ICON_STAMP) ## Generate iOS AppIcon assets when missing or stale

ios-icons-force: ## Force-regenerate iOS AppIcon assets from the shared OpenAgentd icon
	python3 ../scripts/generate_icons.py
	@if [ -d src-tauri/icons/ios ]; then \
		mkdir -p $(IOS_APPICONSET); \
		cp src-tauri/icons/ios/*.png $(IOS_APPICONSET)/; \
		touch $(IOS_ICON_STAMP); \
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
