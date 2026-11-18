"""The shell lines the adapter runs in a task container."""

from __future__ import annotations

import shlex

# Where a Linux image keeps its CA certificates, in the order agentd looks.
_CA_FILES = (
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/ca-bundle.pem",
    "/etc/pki/tls/cacert.pem",
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    "/etc/ssl/cert.pem",
)

# Prints "yes" when the image has CA certificates, "no" when it has none.
HAS_CA_COMMAND = f"for f in {' '.join(_CA_FILES)}; do if [ -s $f ]; then echo yes; exit 0; fi; done; echo no"


def run_command(*, binary: str, model: str, thinking: str | None, instruction: str, logs: str, ca_file: str) -> str:
    """One ``agentd run`` turn with ``instruction`` as the prompt.

    ``ca_file`` is the bundle the adapter uploads to an image that has no CA
    certificates; without one agentd reaches no provider.
    """
    level = f" --thinking {shlex.quote(thinking)}" if thinking else ""
    ca = shlex.quote(ca_file)
    return (
        f"if [ -s {ca} ]; then export SSL_CERT_FILE={ca}; fi; "
        # `--prompt=`: an instruction may start with a dash.
        f"{shlex.quote(binary)} run --json --model {shlex.quote(model)}{level} "
        f"--prompt={shlex.quote(instruction)} "
        f"> {logs}/openagentd.jsonl 2> {logs}/openagentd.stderr"
    )
