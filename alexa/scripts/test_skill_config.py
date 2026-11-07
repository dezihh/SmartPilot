#!/usr/bin/env python3
"""Tests fuer alexa/scripts/skill_config.py (nur Standardbibliothek)."""

import contextlib
import io
import sys
import unittest
from unittest import mock

import skill_config


class PrintEnvTest(unittest.TestCase):
    def test_print_env_enthaelt_invocation_name(self):
        # Regression F-004: deploy-aws-lambda.yml liest die Lambda-Umgebung
        # aus --print-env. Fehlt invocation_name, wirkt eine Umbenennung des
        # Skills nur im hosted Pfad.
        data = skill_config.load()["locales"]["de-DE"]
        buf = io.StringIO()
        with mock.patch.object(sys, "argv", ["skill_config.py", "--print-env", "de-DE"]):
            with contextlib.redirect_stdout(buf):
                skill_config.main()

        values = dict(line.split("=", 1) for line in buf.getvalue().splitlines())
        self.assertEqual(
            values,
            {
                "SKILL_NAME": data["skill_name"],
                "ASSISTANT_NAME": data["assistant_name"],
                "INVOCATION_NAME": data["invocation_name"],
            },
        )


if __name__ == "__main__":
    unittest.main()