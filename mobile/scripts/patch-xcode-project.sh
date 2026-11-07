#!/usr/bin/env bash
#
# Patch the generated Xcode project files (project.pbxproj and project.yml)
# to post-process libapp.a after `cargo tauri ios xcode-script`.
#
# `cargo tauri ios init` regenerates `src-tauri/gen/apple/` from a
# template on every run, so this script must be re-applied after every
# `ios-init` (see mobile/Makefile).

set -euo pipefail

cd "$(dirname "$0")/.."

pbxproj="src-tauri/gen/apple/openagentd-mobile.xcodeproj/project.pbxproj"
project_yml="src-tauri/gen/apple/project.yml"

python3 - <<'EOF'
import os

pbxproj = "src-tauri/gen/apple/openagentd-mobile.xcodeproj/project.pbxproj"
project_yml = "src-tauri/gen/apple/project.yml"

hook_cmd = ' && \\"$SRCROOT/../../../scripts/postprocess-libapp.sh\\"'
hook_yml = ' && "$SRCROOT/../../../scripts/postprocess-libapp.sh"'

if os.path.isfile(pbxproj):
    with open(pbxproj, "r") as f:
        content = f.read()
    if "postprocess-libapp.sh" not in content:
        marker = "cargo tauri ios xcode-script"
        idx = content.find(marker)
        if idx != -1:
            end_quote = content.find('";', idx)
            if end_quote != -1:
                # xcodegen ends the script with an escaped newline; the hook
                # must join the same line, or the shell sees a lone `&&`.
                while content[end_quote - 2:end_quote] == "\\n":
                    end_quote -= 2
                new_content = content[:end_quote] + hook_cmd + content[end_quote:]
                with open(pbxproj, "w") as f:
                    f.write(new_content)
                print("patch-xcode-project: patched project.pbxproj")
            else:
                print("patch-xcode-project: warning: closing quote not found in project.pbxproj")
        else:
            print("patch-xcode-project: warning: cargo tauri ios xcode-script not found in project.pbxproj")
    else:
        new_content = content.replace('$SRCROOT/../../scripts/postprocess-libapp.sh', '$SRCROOT/../../../scripts/postprocess-libapp.sh')
        with open(pbxproj, "w") as f:
            f.write(new_content)

if os.path.isfile(project_yml):
    with open(project_yml, "r") as f:
        content = f.read()
    if "postprocess-libapp.sh" not in content:
        marker = "cargo tauri ios xcode-script"
        idx = content.find(marker)
        if idx != -1:
            eol = content.find("\n", idx)
            if eol != -1:
                new_content = content[:eol] + hook_yml + content[eol:]
                with open(project_yml, "w") as f:
                    f.write(new_content)
                print("patch-xcode-project: patched project.yml")
            else:
                print("patch-xcode-project: warning: newline not found in project.yml")
        else:
            print("patch-xcode-project: warning: cargo tauri ios xcode-script not found in project.yml")
    else:
        new_content = content.replace('$SRCROOT/../../scripts/postprocess-libapp.sh', '$SRCROOT/../../../scripts/postprocess-libapp.sh')
        with open(project_yml, "w") as f:
            f.write(new_content)
EOF
