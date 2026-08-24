/*
 * Copyright The OpenTelemetry Authors
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

interface SourceFileContents {
  path: string;
  contents: string;
}

function getSourceFiles(directory: string): SourceFileContents[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return getSourceFiles(entryPath);
    return entry.name.endsWith('.ts')
      ? [{ path: entryPath, contents: fs.readFileSync(entryPath, 'utf8') }]
      : [];
  });
}

describe('oracledb imports', () => {
  const sourceFiles = getSourceFiles(path.resolve(__dirname, '../src'));

  it('uses oracledb only as a type in src', () => {
    for (const file of sourceFiles) {
      const source = ts.createSourceFile(
        file.path,
        file.contents,
        ts.ScriptTarget.Latest,
        true
      );

      for (const statement of source.statements) {
        if (
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text === 'oracledb'
        ) {
          assert.ok(
            statement.importClause?.isTypeOnly,
            `${file.path} must import oracledb with \`import type\``
          );
        }
      }
    }
  });

  it('does not emit runtime oracledb imports', () => {
    for (const file of sourceFiles) {
      const output = ts.transpileModule(file.contents, {
        compilerOptions: {
          module: ts.ModuleKind.Node16,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;

      assert.doesNotMatch(
        output,
        /(?:require|import)\(\s*['"]oracledb['"]\s*\)/,
        `${file.path} must not emit a runtime oracledb import`
      );
    }
  });
});
