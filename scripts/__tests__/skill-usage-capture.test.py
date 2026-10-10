#!/usr/bin/env python3
"""Unit tests for scripts/hooks/skill-usage-capture.py.

Tests cover _classify() and _agent_id_from_cwd() -- the two pure-logic
functions that determine what gets logged and under which agent.

Privacy: only fake agent IDs (agent-a, agent-b) and synthetic paths are used.
"""
import sys
import os
import unittest

# Resolve the hook module without importing as a side-effect runner.
import importlib.util

_HOOK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks", "skill-usage-capture.py",
)

_spec = importlib.util.spec_from_file_location("skill_usage_capture", _HOOK_PATH)
hook = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(hook)  # type: ignore[union-attr]


class TestClassify(unittest.TestCase):
    """_classify(tool_name, tool_input) -> (skill_name, trigger_type) | None"""

    def _call(self, tool_name, tool_input):
        return hook._classify(tool_name, tool_input)

    # Skill tool ----------------------------------------------------------------

    def test_skill_tool_returns_tool_call(self):
        result = self._call("Skill", {"skill": "fleet-helper"})
        self.assertEqual(result, ("fleet-helper", "tool_call"))

    def test_skill_tool_args_variant(self):
        result = self._call("Skill", {"skill": "deep-research", "args": "something"})
        self.assertIsNotNone(result)
        self.assertEqual(result[0], "deep-research")
        self.assertEqual(result[1], "tool_call")

    def test_skill_tool_strips_whitespace(self):
        result = self._call("Skill", {"skill": "  fleet-helper  "})
        self.assertEqual(result, ("fleet-helper", "tool_call"))

    def test_skill_tool_empty_name_returns_none(self):
        result = self._call("Skill", {"skill": ""})
        self.assertIsNone(result)

    def test_skill_tool_missing_skill_key_returns_none(self):
        result = self._call("Skill", {})
        self.assertIsNone(result)

    # Read tool + SKILL.md path -------------------------------------------------

    def test_read_skill_md_returns_skill_read(self):
        home = os.path.expanduser("~")
        path = f"{home}/.claude/skills/fleet-helper/SKILL.md"
        result = self._call("Read", {"file_path": path})
        self.assertEqual(result, ("fleet-helper", "skill_read"))

    def test_read_skill_md_extracts_skill_name(self):
        home = os.path.expanduser("~")
        path = f"{home}/.claude/skills/deep-research/SKILL.md"
        result = self._call("Read", {"file_path": path})
        self.assertIsNotNone(result)
        self.assertEqual(result[0], "deep-research")

    def test_read_non_skill_md_returns_none(self):
        home = os.path.expanduser("~")
        # Only the SKILL.md at the top of a skill dir should match.
        result = self._call("Read", {"file_path": f"{home}/.claude/skills/fleet-helper/references/extra.md"})
        self.assertIsNone(result)

    def test_read_arbitrary_file_returns_none(self):
        result = self._call("Read", {"file_path": "/some/other/file.md"})
        self.assertIsNone(result)

    def test_read_no_file_path_returns_none(self):
        result = self._call("Read", {})
        self.assertIsNone(result)

    # Other tools ----------------------------------------------------------------

    def test_bash_tool_returns_none(self):
        self.assertIsNone(self._call("Bash", {"command": "echo hi"}))

    def test_write_tool_returns_none(self):
        self.assertIsNone(self._call("Write", {"file_path": "/tmp/x.txt", "content": "x"}))

    def test_edit_tool_returns_none(self):
        self.assertIsNone(self._call("Edit", {"file_path": "/tmp/x.txt"}))

    def test_websearch_returns_none(self):
        self.assertIsNone(self._call("WebSearch", {"query": "something"}))

    def test_unknown_tool_returns_none(self):
        self.assertIsNone(self._call("UnknownTool", {"key": "value"}))


class TestAgentIdFromCwd(unittest.TestCase):
    """_agent_id_from_cwd(cwd) derives the agent identity from the session cwd."""

    def _call(self, cwd):
        return hook._agent_id_from_cwd(cwd)

    def _install(self):
        return hook._install_dir()

    def test_agents_subdir_returns_agent_name(self):
        install = self._install()
        cwd = os.path.join(install, "agents", "agent-a")
        self.assertEqual(self._call(cwd), "agent-a")

    def test_agents_subdir_nested_returns_first_segment(self):
        install = self._install()
        cwd = os.path.join(install, "agents", "agent-b", "subdir")
        self.assertEqual(self._call(cwd), "agent-b")

    def test_install_root_returns_main_agent_id(self):
        install = self._install()
        result = self._call(install)
        # Should fall back to MAIN_AGENT_ID or 'marveen'
        self.assertIsInstance(result, str)
        self.assertTrue(len(result) > 0)

    def test_empty_cwd_returns_nonempty_string(self):
        result = self._call("")
        self.assertIsInstance(result, str)
        self.assertTrue(len(result) > 0)

    def test_trailing_slash_ignored(self):
        install = self._install()
        cwd_with_slash = os.path.join(install, "agents", "agent-a") + "/"
        self.assertEqual(self._call(cwd_with_slash), "agent-a")

    # Regression guards for the drifted-private-copy bug: the hook used to
    # carry its own resolver that missed the install-subdirectory case and
    # invented an agent id from the cwd basename, so skill_usage rows were
    # attributed to a directory name instead of a real agent.

    def test_delegates_to_the_shared_ledger_resolver(self):
        import sys as _sys
        _sys.path.insert(0, os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks"))
        import ledger_lib
        self.assertIs(hook._agent_id_from_cwd, ledger_lib.agent_id_from_cwd)

    def test_install_subdir_is_main_agent_not_directory_name(self):
        install = self._install()
        cwd = os.path.join(install, "store", "some-workdir")
        # The drifted copy returned "some-workdir" here.
        self.assertNotEqual(self._call(cwd), "some-workdir")


# 2026-09-14: a SKILL.md-minta kiterjesztese
# projekt-szintu skillekre. A REGI minta csak a futo felhasznalo HOME-ja ala
# illeszkedett, ezert a <install>/.claude/skills/<nev>/SKILL.md olvasasa SOHA nem
# keletkeztetett skill_usage sort. Merve aznap: 71 telepitett skillhez 4 usage-sor,
# mind `tool_call`, egyetlen `skill_read` sem. Ez a negy eset pinneli az uj hatart.
class TestProjectScopedSkills(unittest.TestCase):
    def _classify(self, path):
        return hook._classify("Read", {"file_path": path})

    def test_project_scoped_skill_md_matches(self):
        self.assertEqual(
            self._classify("/srv/marveen/.claude/skills/my-skill/SKILL.md"),
            ("my-skill", "skill_read"),
        )

    def test_home_scoped_still_matches(self):
        home = os.path.expanduser("~")
        self.assertEqual(
            self._classify(f"{home}/.claude/skills/fleet-helper/SKILL.md"),
            ("fleet-helper", "skill_read"),
        )

    def test_scheduled_task_skill_md_does_not_match(self):
        # A scheduled-tasks SKILL.md NEM skill, hanem egy utemezett feladat promptja.
        home = os.path.expanduser("~")
        self.assertIsNone(self._classify(f"{home}/.claude/scheduled-tasks/foo/SKILL.md"))

    def test_nested_reference_still_does_not_match(self):
        self.assertIsNone(self._classify("/srv/marveen/.claude/skills/my-skill/references/x.md"))




class TestBashSkillRead(unittest.TestCase):
    """2026-10-10 (Zeph 3261, Marveen 3263): a SKILL.md read from Bash is a skill_read row too.

    Before, only the Read tool counted, so every "unused skill" conclusion of the dream-engine stood on
    a measuring gap (the gws skills, for one, are read with cat/sed). Both directions are pinned: the
    reads that must count, and the commands that only NAME the file without reading it.
    """

    def _bash(self, command):
        return hook._classify_all("Bash", {"command": command})

    def _names(self, command):
        return [n for n, t in self._bash(command) if t == "skill_read"]

    # must count ------------------------------------------------------------
    def test_cat_relative(self):
        self.assertEqual(self._bash("cat .claude/skills/x/SKILL.md"), [("x", "skill_read")])

    def test_sed_n_absolute(self):
        self.assertEqual(self._names("sed -n 1,40p /home/pohi/marveen/.claude/skills/fleet-helper/SKILL.md"), ["fleet-helper"])

    def test_head_in_a_pipeline(self):
        self.assertEqual(self._names("head -50 ~/x/.claude/skills/gws-gmail/SKILL.md | grep -n send"), ["gws-gmail"])

    def test_after_cd_and_env_prefix(self):
        self.assertEqual(self._names("cd /home/pohi/marveen && LC_ALL=C grep -n Mikor .claude/skills/meresi-csapdak/SKILL.md"), ["meresi-csapdak"])

    def test_python_dash_c(self):
        self.assertEqual(self._names("python3 -c \"print(open('.claude/skills/y/SKILL.md').read()[:200])\""), ["y"])

    def test_python_heredoc(self):
        cmd = "python3 - <<'PY'\ntext = open('/home/pohi/marveen/.claude/skills/z/SKILL.md').read()\nprint(len(text))\nPY"
        self.assertEqual(self._names(cmd), ["z"])

    def test_two_skills_in_one_command_both_count_once(self):
        cmd = "cat .claude/skills/a/SKILL.md .claude/skills/b/SKILL.md; cat .claude/skills/a/SKILL.md"
        self.assertEqual(self._names(cmd), ["a", "b"])

    # must NOT count --------------------------------------------------------
    def test_cat_of_another_file(self):
        self.assertEqual(self._bash("cat README.md"), [])

    def test_a_reference_file_of_a_skill(self):
        self.assertEqual(self._bash("cat .claude/skills/x/references/notes.md"), [])

    def test_naming_without_reading(self):
        for cmd in ("ls -la .claude/skills/x/SKILL.md", "git add .claude/skills/x/SKILL.md",
                    "git -C .claude/skills diff -- x/SKILL.md", "stat .claude/skills/x/SKILL.md",
                    "cp /tmp/new.md .claude/skills/x/SKILL.md"):
            self.assertEqual(self._bash(cmd), [], cmd)

    def test_in_place_edit_is_not_use(self):
        self.assertEqual(self._bash("sed -i 's/a/b/' .claude/skills/x/SKILL.md"), [])
        self.assertEqual(self._bash("sed -i.bak -e 's/a/b/' .claude/skills/x/SKILL.md"), [])

    def test_redirect_target_is_a_write(self):
        self.assertEqual(self._bash("cat /tmp/draft.md > .claude/skills/x/SKILL.md"), [])
        self.assertEqual(self._bash("echo hi >> .claude/skills/x/SKILL.md"), [])

    def test_a_glob_is_not_one_skill(self):
        self.assertEqual(self._bash("for f in .claude/skills/*/SKILL.md; do head -3 $f; done"), [])
        self.assertEqual(self._bash("cat .claude/skills/*/SKILL.md | wc -l"), [])

    def test_other_tools_unchanged(self):
        self.assertEqual(hook._classify_all("Read", {"file_path": "/srv/m/.claude/skills/r/SKILL.md"}), [("r", "skill_read")])
        self.assertEqual(hook._classify_all("Skill", {"skill": "s"}), [("s", "tool_call")])
        self.assertEqual(hook._classify_all("Grep", {"pattern": "x", "path": ".claude/skills/x/SKILL.md"}), [])

    def test_the_no_match_path_does_not_load_urllib(self):
        # the hook runs on EVERY Bash call now; urllib.request is imported only when a row is posted
        import subprocess, json as _json
        out = subprocess.run(
            [sys.executable, "-X", "importtime", _HOOK_PATH],
            input=_json.dumps({"tool_name": "Bash", "tool_input": {"command": "ls -la"}, "cwd": "/tmp"}),
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(out.returncode, 0)
        self.assertNotIn("urllib.request", out.stderr)

if __name__ == "__main__":
    unittest.main(verbosity=2)
