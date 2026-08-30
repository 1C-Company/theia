// *****************************************************************************
// Copyright (C) 2026 1C-Soft LLC and others.
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

import { CancellationToken, Disposable, Emitter, ILogger, nls, URI } from '@theia/core';
import { inject, injectable, named } from '@theia/core/shared/inversify';
import { codicon } from '@theia/core/lib/browser';
import {
    ScmHistoryItem,
    ScmHistoryItemChange,
    ScmHistoryItemRef,
    ScmHistoryItemRefsChangeEvent,
    ScmHistoryItemStatistics,
    ScmHistoryOptions,
    ScmHistoryProvider } from '@theia/scm/lib/browser/scm-provider';
import { Branch, BranchType, Git, GitStatusChangeEvent, GitUtils, Repository, Tag } from '../common';
import { GitRepositoryTracker } from './git-repository-tracker';
import { GitScmProvider } from './git-scm-provider';
import { GIT_RESOURCE_SCHEME } from './git-resource';

export function parseRemoteRefName(remoteRefName: string): { remote: string, branch: string } {
    const slashIdx = remoteRefName.indexOf('/');
    const remote = remoteRefName.substring(0, slashIdx);
    const branch = remoteRefName.substring(slashIdx + 1);
    return { remote, branch };
}

export enum GitHistoryItemPlaceholders {
    HASH = '%H',
    AUTHOR_NAME = '%aN',
    AUTHOR_EMAIL = '%aE',
    AUTHOR_DATE = '%at',
    SUBJECT = '%s',
    MESSAGE = '%B',
    PARENTS = '%P',
    REF_NAMES = '%D'
}

@injectable()
export class GitHistoryItemRefsParser {

    readonly format = '%(refname)%00%(objectname)%00%(*objectname)';

    parse(data: string): ScmHistoryItemRef[] {
        const result: ScmHistoryItemRef[] = [];

        const lines = data.trim().split('\n');

        for (const line of lines) {
            const entry = line.trim();
            if (!entry) {
                continue;
            }

            const [refName, commitHash, tagCommitHash] = entry.split('\0');
            const revision = tagCommitHash || commitHash || undefined;
            const shortRevision = revision?.substring(0, 7);

            if (refName.startsWith('refs/heads/')) {
                result.push({
                    id: refName,
                    name: refName.substring('refs/heads/'.length),
                    description: shortRevision,
                    revision,
                    icon: codicon('git-branch'),
                    category: nls.localize('vscode.git/bundle/branches', 'branches')
                });
            } else if (refName.startsWith('refs/remotes/')) {
                result.push({
                    id: refName,
                    name: refName.substring('refs/remotes/'.length),
                    description: shortRevision && nls.localize('vscode.git/bundle/Remote branch at {0}', 'Remote branch at {0}', shortRevision),
                    revision,
                    icon: codicon('cloud'),
                    category: nls.localize('vscode.git/bundle/remote branches', 'remote branches')
                });
            } else if (refName.startsWith('refs/tags/')) {
                result.push({
                    id: refName,
                    name: refName.substring('refs/tags/'.length),
                    description: shortRevision && nls.localize('vscode.git/bundle/Tag at {0}', 'Tag at {0}', shortRevision),
                    revision,
                    icon: codicon('tag'),
                    category: nls.localize('vscode.git/bundle/tags', 'tags')
                });
            }
        }

        return result;
    }
}

@injectable()
export class GitHistoryItemStatisticsParser {

    protected static readonly REGEX = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

    parse(data: string): ScmHistoryItemStatistics {
        const matches = data.trim().match(GitHistoryItemStatisticsParser.REGEX);

        if (!matches) {
            return { files: 0, insertions: 0, deletions: 0 };
        }

        const [, files, insertions, deletions] = matches;
        return { files: parseInt(files), insertions: parseInt(insertions ?? '0'), deletions: parseInt(deletions ?? '0') };
    }
}

@injectable()
export class GitHistoryItemsParser {

    protected static readonly PLACEHOLDERS = Object.values(GitHistoryItemPlaceholders);

    @inject(GitHistoryItemStatisticsParser) protected readonly historyItemStatisticsParser: GitHistoryItemStatisticsParser;

    readonly format = '%x02' + GitHistoryItemsParser.PLACEHOLDERS.join('%x01') + '%x01';

    parse(data: string): ScmHistoryItem[] {
        const result: ScmHistoryItem[] = [];

        const entries = data.trim().split('\x02');

        for (const entry of entries) {
            if (!entry) {
                continue;
            }

            const [hash, author, authorEmail, authorDate, subject, message, parents, refNames, shortStat] = entry.split('\x01');

            result.push({
                id: hash,
                parentIds: parents ? parents.split(' ') : [],
                subject,
                message,
                author,
                authorEmail,
                timestamp: Number(authorDate) * 1000,
                statistics: shortStat ? this.historyItemStatisticsParser.parse(shortStat) : undefined,
                references: refNames ? this.toHistoryItemRefs(refNames.split(',').map(s => s.trim()), hash) : []
            });
        }

        return result;
    }

    protected toHistoryItemRefs(refs: string[], revision: string): ScmHistoryItemRef[] {
        const result: ScmHistoryItemRef[] = [];

        for (const ref of refs) {
            if (ref === 'refs/remotes/origin/HEAD') {
                continue;
            }

            if (ref.startsWith('HEAD -> refs/heads/')) {
                result.push({
                    id: ref.substring('HEAD -> '.length),
                    name: ref.substring('HEAD -> refs/heads/'.length),
                    revision,
                    icon: codicon('target'),
                    category: nls.localize('vscode.git/bundle/branches', 'branches')
                });
            } else if (ref.startsWith('refs/heads/')) {
                result.push({
                    id: ref,
                    name: ref.substring('refs/heads/'.length),
                    revision,
                    icon: codicon('git-branch'),
                    category: nls.localize('vscode.git/bundle/branches', 'branches')
                });
            } else if (ref.startsWith('refs/remotes/')) {
                result.push({
                    id: ref,
                    name: ref.substring('refs/remotes/'.length),
                    revision,
                    icon: codicon('cloud'),
                    category: nls.localize('vscode.git/bundle/remote branches', 'remote branches')
                });
            } else if (ref.startsWith('tag: refs/tags/')) {
                result.push({
                    id: ref.substring('tag: '.length),
                    name: ref.substring('tag: refs/tags/'.length),
                    revision,
                    icon: codicon('tag'),
                    category: nls.localize('vscode.git/bundle/tags', 'tags')
                });
            }
        }

        return result.sort((a, b) => a.id.localeCompare(b.id));
    }
}

@injectable()
export class GitHistoryItemChangesParser {

    parse(data: string, repositoryUri: string, originalRef: string, modifiedRef: string): ScmHistoryItemChange[] {
        const result: ScmHistoryItemChange[] = [];

        const entries = data.trim().split('\0').filter(entry => entry);

        let index = 0;
        while (index < entries.length) {
            let originalUri: string | undefined;
            let modifiedUri: string | undefined;

            const rawStatus = entries[index++].trim();
            if (GitUtils.isSimilarityStatus(rawStatus)) {
                originalUri = this.toGitUri(this.toUri(repositoryUri, entries[index++]), originalRef);
                modifiedUri = this.toGitUri(this.toUri(repositoryUri, entries[index++]), modifiedRef);
            } else {
                const uri = this.toUri(repositoryUri, entries[index++]);
                originalUri = rawStatus === 'A' ? undefined : this.toGitUri(uri, originalRef);
                modifiedUri = rawStatus === 'D' ? undefined : this.toGitUri(uri, modifiedRef);
            }

            result.push({
                originalUri,
                modifiedUri,
                uri: modifiedUri ?? originalUri!
            });
        }

        return result;
    }

    protected toUri(repositoryUri: string, path: string): string {
        return new URI(repositoryUri).resolve(path).toString();
    }

    protected toGitUri(uri: string, ref: string): string {
        return new URI(uri).withScheme(GIT_RESOURCE_SCHEME).withQuery(ref).toString();
    }
}

@injectable()
export class GitHistoryProvider implements ScmHistoryProvider {

    @inject(ILogger) @named('git:GitHistoryProvider') protected readonly logger: ILogger;
    @inject(GitScmProvider) protected readonly provider: GitScmProvider;
    @inject(Git) protected readonly git: Git;
    @inject(GitRepositoryTracker) protected readonly repositoryTracker: GitRepositoryTracker;
    @inject(GitHistoryItemRefsParser) protected readonly historyItemRefsParser: GitHistoryItemRefsParser;
    @inject(GitHistoryItemsParser) protected readonly historyItemsParser: GitHistoryItemsParser;
    @inject(GitHistoryItemChangesParser) protected readonly historyItemChangesParser: GitHistoryItemChangesParser;

    get repository(): Repository {
        return this.provider.repository;
    }

    /** Tracks the active subscription to the repository tracker */
    protected onGitEventDisposable?: Disposable;
    /** Counts how many total listeners are attached to this provider */
    protected listenerCount = 0;

    protected readonly onDidChangeHistoryItemRefsEmitter = new Emitter<ScmHistoryItemRefsChangeEvent>({
        onFirstListenerAdd: () => this.incrementListeners(),
        onLastListenerRemove: () => this.decrementListeners()
    });
    readonly onDidChangeHistoryItemRefs = this.onDidChangeHistoryItemRefsEmitter.event;

    protected readonly onDidChangeCurrentHistoryItemRefsEmitter = new Emitter<void>({
        onFirstListenerAdd: () => this.incrementListeners(),
        onLastListenerRemove: () => this.decrementListeners()
    });
    readonly onDidChangeCurrentHistoryItemRefs = this.onDidChangeCurrentHistoryItemRefsEmitter.event;

    protected _historyItemRefs?: ScmHistoryItemRef[];

    protected _currentHistoryItemRef?: ScmHistoryItemRef;
    get currentHistoryItemRef(): ScmHistoryItemRef | undefined {
        return this._currentHistoryItemRef;
    }

    protected _currentHistoryItemRemoteRef?: ScmHistoryItemRef;
    get currentHistoryItemRemoteRef(): ScmHistoryItemRef | undefined {
        return this._currentHistoryItemRemoteRef;
    }

    protected _currentHistoryItemBaseRef?: ScmHistoryItemRef;
    get currentHistoryItemBaseRef(): ScmHistoryItemRef | undefined {
        return this._currentHistoryItemBaseRef;
    }

    async provideHistoryItemRefs(historyItemRefs: string[] | undefined, token: CancellationToken): Promise<ScmHistoryItemRef[] | undefined> {
        try {
            const args = ['for-each-ref', '--format', this.historyItemRefsParser.format, '--sort=-creatordate']; // lists newest branches/tags first

            if (historyItemRefs) {
                const refNames = Array.from(new Set(historyItemRefs)); // deduplicate ref-names
                args.push(...refNames);
            }

            const { stdout } = await this.git.exec(this.repository, args, { readOnly: true });

            if (token.isCancellationRequested) {
                return undefined;
            }

            return this.historyItemRefsParser.parse(stdout);
        } catch (error) {
            this.logger.error(error);
            return undefined;
        }
    }

    async provideHistoryItems(options: ScmHistoryOptions, token: CancellationToken): Promise<ScmHistoryItem[] | undefined> {
        if (!options.historyItemRefs) {
            return undefined;
        }
        try {
            const refNames = Array.from(new Set(options.historyItemRefs)); // deduplicate ref-names

            const args = ['log', `--format=${this.historyItemsParser.format}`, '-z',
                '--shortstat', '--diff-merges=first-parent', '--topo-order', '--decorate=full', '--stdin'];

            if (options.skip) {
                args.push(`--skip=${options.skip}`);
            }

            if (options.limit === undefined || typeof options.limit === 'number') {
                args.push(`-n${options.limit ?? 50}`);
            } else if (options.limit.id) {
                const historyItem = await this.resolveHistoryItem(options.limit.id, token);
                if (token.isCancellationRequested) {
                    return undefined;
                }
                if (historyItem) {
                    const parentId = historyItem.parentIds?.[0] ?? await this.getEmptyTree();
                    args.push(`${parentId}..`);
                }
            }

            const { stdout } = await this.git.exec(this.repository, args, { stdin: refNames.join('\n'), readOnly: true });

            if (token.isCancellationRequested) {
                return undefined;
            }

            return this.historyItemsParser.parse(stdout);
        } catch (error) {
            this.logger.error(error);
            return undefined;
        }
    }

    async provideHistoryItemChanges(historyItemId: string, historyItemParentId: string | undefined, token: CancellationToken): Promise<ScmHistoryItemChange[] | undefined> {
        try {
            if (historyItemParentId === undefined) {
                historyItemParentId = await this.getEmptyTree();
            }

            if (token.isCancellationRequested) {
                return undefined;
            }

            const { stdout } = await this.git.exec(this.repository, ['diff-tree', '-r', '--name-status', '--diff-filter=ADMR', '--find-renames', '-z',
                historyItemParentId, historyItemId, '--'], { readOnly: true });

            if (token.isCancellationRequested) {
                return undefined;
            }

            return this.historyItemChangesParser.parse(stdout, this.repository.localUri, historyItemParentId, historyItemId);
        } catch (error) {
            this.logger.error(error);
            return undefined;
        }
    }

    async resolveHistoryItem(historyItemId: string, token: CancellationToken): Promise<ScmHistoryItem | undefined> {
        try {
            const { stdout } = await this.git.exec(this.repository, ['show', `--format=${this.historyItemsParser.format}`, '-s', '-z',
                '--shortstat', '--decorate=full', historyItemId, '--'], { readOnly: true });

            if (token.isCancellationRequested) {
                return undefined;
            }

            return this.historyItemsParser.parse(stdout)[0];
        } catch (error) {
            this.logger.error(error);
            return undefined;
        }
    }

    async resolveHistoryItemRefsCommonAncestor(historyItemRefs: string[], token: CancellationToken): Promise<string | undefined> {
        return undefined; // method not implemented
    }

    protected incrementListeners(): void {
        this.listenerCount++;
        if (this.listenerCount === 1 && !this.onGitEventDisposable) {
            this.onGitEventDisposable = this.repositoryTracker.onGitEvent(this.handleGitStatusChange, this);
        }
    }

    protected decrementListeners(): void {
        this.listenerCount--;
        if (this.listenerCount === 0 && this.onGitEventDisposable) {
            this.onGitEventDisposable.dispose();
            this.onGitEventDisposable = undefined;
        }
    }

    protected async handleGitStatusChange(event: GitStatusChangeEvent | undefined): Promise<void> {
        if (!event || event.source.localUri !== this.repository.localUri) {
            return;
        }

        const { branch, upstreamBranch, currentHead, branches, tags } = event.status;

        const historyItemRefs = this.toHistoryItemRefs(branches, tags);
        const { added, removed, modified } = this._historyItemRefs && historyItemRefs ?
            this.deltaHistoryItemRefs(this._historyItemRefs, historyItemRefs) :
            { added: [], removed: [], modified: [] };
        this._historyItemRefs = historyItemRefs;

        const branchChanged = this._currentHistoryItemRef?.id !== (branch ? 'refs/heads/' + branch : currentHead);
        const upstreamBranchChanged = this.currentHistoryItemRemoteRef?.id !== (upstreamBranch ? 'refs/remotes/' + upstreamBranch : undefined);
        const baseBranchRemoved = !!removed.find(ref => ref.id === this._currentHistoryItemBaseRef?.id);

        let currentHistoryItemRefsChanged = false;
        if (branchChanged || upstreamBranchChanged || baseBranchRemoved) {
            currentHistoryItemRefsChanged = true;

            if (branchChanged) {
                this._currentHistoryItemRef = branch ? {
                    id: 'refs/heads/' + branch,
                    name: branch
                } : currentHead ? { // detached HEAD
                    id: currentHead,
                    name: currentHead,
                    revision: currentHead
                } : undefined;
            }

            if (branchChanged || baseBranchRemoved) {
                this._currentHistoryItemBaseRef = await this.getBaseRef(this._currentHistoryItemRef);
            }

            if (upstreamBranchChanged) {
                this._currentHistoryItemRemoteRef = upstreamBranch ? await this.getBranchRef('refs/remotes/' + upstreamBranch) : undefined;
            }

            if (this._currentHistoryItemBaseRef?.id === this._currentHistoryItemRemoteRef?.id) {
                this._currentHistoryItemBaseRef = undefined;
            }
        }

        const updateRevision = (ref: ScmHistoryItemRef | undefined): void => {
            if (ref && branches) {
                const branchType = ref.id.startsWith('refs/heads/') ? BranchType.Local : ref.id.startsWith('refs/remotes/') ? BranchType.Remote : undefined;
                if (branchType !== undefined) {
                    const found = branches.find(b => b.name === ref.name && b.type === branchType);
                    if (found) {
                        const oldRevision = ref.revision;
                        const newRevision = found.tip.sha;
                        if (oldRevision !== newRevision) {
                            (ref as { revision: string }).revision = newRevision;
                            currentHistoryItemRefsChanged = true;
                        }
                    }
                }
            }
        };

        updateRevision(this._currentHistoryItemRef);
        updateRevision(this._currentHistoryItemBaseRef);
        updateRevision(this._currentHistoryItemRemoteRef);

        if (currentHistoryItemRefsChanged) {
            this.onDidChangeCurrentHistoryItemRefsEmitter.fire(undefined);
        }

        if (added.length + removed.length + modified.length > 0) {
            this.onDidChangeHistoryItemRefsEmitter.fire({ added, removed, modified });
        }
    }

    protected toHistoryItemRefs(branches: readonly Branch[] | undefined, tags: readonly Tag[] | undefined): ScmHistoryItemRef[] | undefined {
        if (!branches && !tags) {
            return undefined;
        }

        const result: ScmHistoryItemRef[] = [];

        branches?.forEach(branch => result.push({
            id: (branch.type === BranchType.Remote ? 'refs/remotes/' : 'refs/heads/') + branch.name,
            name: branch.name,
            revision: branch.tip.sha,
            icon: branch.type === BranchType.Remote ? codicon('cloud') : codicon('git-branch'),
            category: branch.type === BranchType.Remote ?
                nls.localize('vscode.git/bundle/remote branches', 'remote branches') : nls.localize('vscode.git/bundle/branches', 'branches')
        }));

        tags?.forEach(tag => result.push({
            id: 'refs/tags/' + tag.name,
            name: tag.name,
            icon: codicon('tag'),
            category: nls.localize('vscode.git/bundle/tags', 'tags')
        }));

        return result.sort((a, b) => a.id.localeCompare(b.id));
    }

    protected deltaHistoryItemRefs(before: ScmHistoryItemRef[], after: ScmHistoryItemRef[]): {
        added: ScmHistoryItemRef[];
        removed: ScmHistoryItemRef[];
        modified: ScmHistoryItemRef[];
    } {
        if (before.length === 0) {
            return { added: after, removed: [], modified: [] };
        }

        const added: ScmHistoryItemRef[] = [];
        const removed: ScmHistoryItemRef[] = [];
        const modified: ScmHistoryItemRef[] = [];

        let beforeIdx = 0;
        let afterIdx = 0;

        while (true) {

            if (beforeIdx === before.length) {
                added.push(...after.slice(afterIdx));
                break;
            }

            if (afterIdx === after.length) {
                removed.push(...before.slice(beforeIdx));
                break;
            }

            const beforeElement = before[beforeIdx];
            const afterElement = after[afterIdx];

            const comparisonResult = beforeElement.id.localeCompare(afterElement.id);

            if (comparisonResult === 0) {

                if (beforeElement.revision !== afterElement.revision) {
                    modified.push(afterElement);
                }
                beforeIdx += 1;
                afterIdx += 1;

            } else if (comparisonResult < 0) {

                removed.push(beforeElement);
                beforeIdx += 1;

            } else {

                added.push(afterElement);
                afterIdx += 1;
            }
        }

        return { added, removed, modified };
    }

    protected async getBaseRef(ref: ScmHistoryItemRef | undefined): Promise<ScmHistoryItemRef | undefined> {
        if (!ref || !ref.id.startsWith('refs/heads/')) {
            return undefined;
        }

        let cachedBaseRefId: string | undefined = undefined;
        const baseRefConfigKey = this.getBaseRefConfigKey(ref.name);

        try {
            cachedBaseRefId = (await this.git.exec(this.repository, ['config', '--get', '--local', baseRefConfigKey],
                { successExitCodes: [0, 1], readOnly: true })).stdout.trim();
        } catch (error) {
            this.logger.warn(error);
        }

        if (cachedBaseRefId) {
            const cachedBaseRef = await this.getBranchRef(cachedBaseRefId);
            if (cachedBaseRef) {
                return cachedBaseRef;
            }
        }

        const baseRef = await this.computeBaseRef(ref);

        if (baseRef) {
            try {
                await this.git.exec(this.repository, ['config', '--local', baseRefConfigKey, baseRef.id]);
            } catch (error) {
                this.logger.warn(error);
            }
        }

        return baseRef;
    }

    protected getBaseRefConfigKey(refName: string): string {
        return `branch.${refName}.theia-merge-base`;
    }

    // Note: only remote branches can be used as a base (same as in vscode.git)
    protected async computeBaseRef(ref: ScmHistoryItemRef): Promise<ScmHistoryItemRef | undefined> {
        const baseRefName = await this.getBaseRefNameFromReflog(ref);
        if (baseRefName) {
            const baseRef = await this.getBranchRef(baseRefName);
            if (baseRef) {
                if (baseRef.id.startsWith('refs/remotes/')) {
                    return baseRef;
                }
                if (baseRef.upstream) {
                    return baseRef.upstream;
                }
            }
        }
        return this.getDefaultBranchRefForDefaultRemote();
    }

    protected async getBaseRefNameFromReflog(ref: ScmHistoryItemRef): Promise<string | undefined> {
        let reflogEntries = await this.reflog(ref.name, 'branch: Created from .*');
        if (reflogEntries.length !== 1) {
            return undefined;
        }

        let match = reflogEntries[0].match(/branch: Created from (.*)$/);
        if (match?.[1] !== 'HEAD') {
            return match?.[1];
        }

        reflogEntries = await this.reflog('HEAD', `checkout: moving from .* to ${ref.name}`);
        if (reflogEntries.length === 0) {
            return undefined;
        }

        match = reflogEntries[reflogEntries.length - 1].match(/checkout: moving from ([^\s]+)\s/);
        return match?.[1];
    }

    protected async reflog(refName: string, pattern: string): Promise<string[]> {
        try {
            const result: string[] = [];

            const { stdout } = await this.git.exec(this.repository, ['reflog', refName, `--grep-reflog=${pattern}`], { readOnly: true });

            const lines = stdout.trim().split('\n');
            for (const line of lines) {
                const entry = line.trim();
                if (entry) {
                    result.push(entry);
                }
            }
            return result;
        } catch (error) {
            this.logger.error(error);
            return [];
        }
    }

    protected async getBranchRef(name: string): Promise<ScmHistoryItemRef & { upstream?: ScmHistoryItemRef } | undefined> {
        const args = ['for-each-ref', '--format=%(refname)%00%(upstream)%00%(upstream:track)'];
        if (/^refs\/(heads|remotes)\//i.test(name)) {
            args.push(name);
        } else {
            args.push(`refs/heads/${name}`, `refs/remotes/${name}`);
        }

        const { stdout } = await this.git.exec(this.repository, args, { readOnly: true });

        const lines = stdout.trim().split('\n');

        for (const line of lines) {
            const entry = line.trim();
            if (!entry) {
                continue;
            }

            const [refName, upstreamRef, upstreamTrack] = entry.split('\0');

            if (refName.startsWith('refs/heads/')) {
                const upstream = upstreamRef?.startsWith('refs/remotes/') && upstreamTrack !== '[gone]' ? {
                    id: upstreamRef,
                    name: upstreamRef.substring('refs/remotes/'.length)
                } : undefined;
                return {
                    id: refName,
                    name: refName.substring('refs/heads/'.length),
                    upstream
                };
            }

            if (refName.startsWith('refs/remotes/')) {
                return {
                    id: refName,
                    name: refName.substring('refs/remotes/'.length)
                };
            }
        }

        return undefined;
    }

    protected async getDefaultBranchRefForDefaultRemote(): Promise<ScmHistoryItemRef | undefined> {
        const remote = await this.getDefaultRemote();
        if (remote) {
            const branch = await this.getDefaultBranchForRemote(remote);
            if (branch) {
                return await this.getBranchRef(branch);
            }
        }
        return undefined;
    }

    protected async getDefaultRemote(): Promise<string | undefined> {
        try {
            const remotes = await this.git.remote(this.repository);
            return remotes.find(remote => remote === 'origin') ?? remotes[0];
        } catch (error) {
            this.logger.error(error);
        }
        return undefined;
    }

    protected async getDefaultBranchForRemote(remote: string): Promise<string | undefined> {
        try {
            const { stdout, exitCode } = (await this.git.exec(this.repository, ['symbolic-ref', `refs/remotes/${remote}/HEAD`],
                { successExitCodes: [0, 1], readOnly: true }));
            if (exitCode === 0) {
                return stdout.trim();
            }
        } catch (error) {
            this.logger.error(error);
        }
        return undefined;
    }

    protected async getEmptyTree(): Promise<string> {
        return (await this.git.exec(this.repository, ['hash-object', '-t', 'tree', '/dev/null'], { readOnly: true })).stdout.trim();
    }
}
