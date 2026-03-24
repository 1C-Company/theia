// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { Git, Repository } from '../common';
import { Resource } from '@theia/core';
import URI from '@theia/core/lib/common/uri';

export const GIT_RESOURCE_SCHEME = 'gitrev';

export class GitResource implements Resource {

    constructor(readonly uri: URI, protected readonly repository: Repository | undefined, protected readonly git: Git) { }

    async readContents(options?: { encoding?: string }): Promise<string> {
        if (this.repository) {
            const commitish = this.uri.query;
            let encoding: Git.Options.Show['encoding'];
            if (options?.encoding === 'utf8' || options?.encoding === 'binary') {
                encoding = options?.encoding;
            }
            if ([':2', ':3'].includes(commitish)) { // special case: index stage number for a merge side
                const path = Repository.relativePath(this.repository, this.uri.withScheme('file'))?.toString();
                if (path) {
                    const stages = (await this.git.exec(this.repository, ['ls-files', '--format=%(stage)', '--', path])).stdout.split('\n').map(line => line.trim());
                    if (stages.includes('1') && !stages.includes(commitish.substring(1))) { // the file was deleted by that side of a merge conflict
                        return '';
                    }
                }
            }
            return this.git.show(this.repository, this.uri.toString(), { commitish, encoding });
        }
        return '';
    }

    async getSize(): Promise<number> {
        if (this.repository) {
            const path = Repository.relativePath(this.repository, this.uri.withScheme('file'))?.toString();
            if (path) {
                const commitish = this.uri.query || 'index';
                if ([':1', ':2', ':3'].includes(commitish)) { // special case: index stage number during merge
                    const lines = (await this.git.exec(this.repository, ['ls-files', '--format=%(stage) %(objectsize)', '--', path])).stdout.split('\n');
                    for (const line of lines) {
                        const [stage, size] = line.trim().split(' ');
                        if (stage === commitish.substring(1) && size) {
                            return parseInt(size);
                        }
                    }
                } else {
                    const args = commitish !== 'index' ? ['ls-tree', '--format=%(objectsize)', commitish, path] : ['ls-files', '--format=%(objectsize)', '--', path];
                    const size = (await this.git.exec(this.repository, args)).stdout.split('\n').filter(line => !!line.trim())[0];
                    if (size) {
                        return parseInt(size);
                    }
                }
            }
        }
        return 0;
    }

    dispose(): void { }
}
