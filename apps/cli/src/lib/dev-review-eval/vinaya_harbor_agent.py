"""The `vinaya` Harbor installed agent: a layer-G trial of the Vinaya roles.

Harbor (version 0.24.0) runs it on a task folder the converter
`harbor-tasks.ts` writes, with this directory on the Python path:

    PYTHONPATH=apps/cli/src/lib/dev-review-eval harbor run \\
        --path <out>/<suite> --agent vinaya_harbor_agent:VinayaAgent \\
        --ak archive=<vinaya.tar> --model <exact model id>

The task image already holds the Vinaya CLI at /opt/vinaya with its workspace
dependencies, installed at image build from the archive the converter wrote
with its `--archive` flag, and the digest of that archive; Claude Code, Bun and
Node are in the image too. `install` uploads this agent's archive and refuses
unless its SHA-256 equals the digest the image recorded, so the run uses the
CLI it was given; it runs no network step. `run` runs
`harbor-trial.ts` on the task's case in container mode, which dispatches the
Vinaya role and writes the agent part of the Vinaya trial record and the run's
usage to the agent log directory, where the task's verifier and this agent read
them.

The Claude login is the subscription token alone: `CLAUDE_CODE_OAUTH_TOKEN` and
`CLAUDE_FORCE_OAUTH`, read from the environment of the `harbor run` process,
never from an agent-env flag, whose values Harbor writes into the job's
configuration. No API key is read or forwarded.
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path, PurePosixPath
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

VINAYA_HOME = PurePosixPath("/opt/vinaya")
ARCHIVE_IN_CONTAINER = PurePosixPath("/tmp/vinaya.tar")
# Written by the task image's build, which installed the archive; see harbor-tasks.ts.
ARCHIVE_DIGEST_FILE = PurePosixPath("/harbor/vinaya-archive.sha256")
CASE_FILE = PurePosixPath("/case/case.json")
CASE_TREE = PurePosixPath("/app")
TRIAL_ENTRY = "apps/cli/src/lib/dev-review-eval/harbor-trial.ts"
RECORD_FILE = "vinaya-trial-record.json"
USAGE_FILE = "vinaya-usage.json"
TRANSCRIPT_FILE = "vinaya-trial.txt"

# The only variables forwarded to the run for its login.
SUBSCRIPTION_ENV = ("CLAUDE_FORCE_OAUTH", "CLAUDE_CODE_OAUTH_TOKEN")


def install_command(
    archive_path: PurePosixPath = ARCHIVE_IN_CONTAINER, digest_path: PurePosixPath = ARCHIVE_DIGEST_FILE
) -> str:
    """The install step: checks the uploaded archive against the one the image installed; no network."""
    archive = shlex.quote(archive_path.as_posix())
    recorded = shlex.quote(digest_path.as_posix())
    missing = shlex.quote(
        f"the task image holds no Vinaya CLI ({digest_path} is missing): "
        "convert the tasks with harbor-tasks.ts --archive <file.tar> and pass the same archive"
    )
    differs = shlex.quote(
        "the Vinaya CLI archive differs from the one the task image installed: "
        "pass the archive harbor-tasks.ts --archive wrote for these tasks"
    )
    return (
        f"if [ ! -s {recorded} ]; then echo {missing} >&2; exit 1; fi && "
        f"if [ \"$(sha256sum {archive} | awk '{{print $1}}')\" != \"$(cat {recorded})\" ]; "
        f"then echo {differs} >&2; exit 1; fi && "
        f"rm -f {archive} && claude --version"
    )


class VinayaAgent(BaseInstalledAgent):
    """Runs one Vinaya role on the task's case through `harbor-trial.ts`."""

    def __init__(self, logs_dir: Path, *args: Any, archive: str | None = None, **kwargs: Any):
        super().__init__(logs_dir, *args, **kwargs)
        if not archive:
            raise ValueError("the vinaya agent needs the Vinaya CLI archive: --ak archive=<path to vinaya.tar>")
        self._archive = Path(archive).expanduser().resolve()
        if not self._archive.is_file():
            raise FileNotFoundError(f"the Vinaya CLI archive is not a file: {self._archive}")
        for name in SUBSCRIPTION_ENV:
            if name in self.extra_env:
                raise ValueError(
                    f"{name} is read from the environment of the harbor run process; "
                    "an agent-env flag would write it into the job's configuration"
                )

    @staticmethod
    def name() -> str:
        return "vinaya"

    async def install(self, environment: BaseEnvironment) -> None:
        await environment.upload_file(self._archive, ARCHIVE_IN_CONTAINER.as_posix())
        await self.exec_as_root(environment, command=install_command())

    def _subscription_env(self) -> dict[str, str]:
        """The run's login, from the environment of the harbor run process only."""
        token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "").strip()
        if not token:
            raise RuntimeError(
                "CLAUDE_CODE_OAUTH_TOKEN is not set in the environment of the harbor run process; "
                "`claude setup-token` prints one for the subscription"
            )
        env = {"CLAUDE_CODE_OAUTH_TOKEN": token}
        force = os.environ.get("CLAUDE_FORCE_OAUTH", "").strip()
        if force:
            env["CLAUDE_FORCE_OAUTH"] = force
        return env

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        # The task statement reaches the role through the case file's rendered
        # process input; the instruction Harbor passes is the same statement.
        if not self.model_name:
            raise ValueError("the vinaya agent needs the exact model id: --model <model id>")
        logs = self.environment_logs_dir.as_posix()
        command = " ".join(
            [
                f"cd {shlex.quote(VINAYA_HOME.as_posix())} &&",
                "bun",
                TRIAL_ENTRY,
                "--case",
                shlex.quote(CASE_FILE.as_posix()),
                "--tree",
                shlex.quote(CASE_TREE.as_posix()),
                "--record",
                shlex.quote(f"{logs}/{RECORD_FILE}"),
                "--usage",
                shlex.quote(f"{logs}/{USAGE_FILE}"),
                "--backend standalone --adapter claude-code",
                "--model",
                shlex.quote(self.model_name),
                f"2>&1 | tee {shlex.quote(f'{logs}/{TRANSCRIPT_FILE}')}",
            ]
        )
        env = {**self._subscription_env(), "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}
        await self.exec_as_agent(environment, command=f"mkdir -p {shlex.quote(logs)} && {command}", env=env)

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Harbor's token and cost figures, from the Vinaya run's usage file."""
        path = self.logs_dir / USAGE_FILE
        if not path.is_file():
            return
        usage = json.loads(path.read_text())
        context.n_input_tokens = int(usage.get("inputTokens", 0))
        # The run's usage counts cache reads and cache creations apart from its uncached input.
        context.n_cache_tokens = int(usage.get("cacheReadTokens", 0)) + int(usage.get("cacheCreationTokens", 0))
        context.n_output_tokens = int(usage.get("outputTokens", 0))
        context.cost_usd = float(usage.get("estimatedCostUsd", 0))
