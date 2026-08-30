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

import { injectable, inject, optional, named } from '@theia/core/shared/inversify';
import { Git, Repository, Branch, BranchType, Tag, Remote, StashEntry } from '../common';
import { GitRepositoryProvider } from './git-repository-provider';
import { ILogger } from '@theia/core';
import { MessageService } from '@theia/core/lib/common/message-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { GitErrorHandler } from './git-error-handler';
import { ProgressService } from '@theia/core/lib/common/progress-service';
import URI from '@theia/core/lib/common/uri';
import { nls } from '@theia/core/lib/common/nls';
import { ConfirmDialog, Dialog, LabelProvider, QuickInputService, QuickPick, QuickPickItem } from '@theia/core/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileStat } from '@theia/filesystem/lib/common/files';
import { ScmHistoryItemRef, ScmHistoryProvider } from '@theia/scm/lib/browser/scm-provider';
import { parseRemoteRefName } from './git-history-provider';

export enum GitAction {
    PULL,
    PUSH
}

/**
 * Service delegating into the `Quick Input Service`, so that the Git commands can be further refined.
 * For instance, the `remote` can be specified for `pull`, `push`, and `fetch`. And the branch can be
 * specified for `git merge`.
 */
@injectable()
export class GitQuickOpenService {

    @inject(ILogger) @named('git:GitQuickOpenService') protected readonly logger: ILogger;
    @inject(GitErrorHandler) protected readonly gitErrorHandler: GitErrorHandler;
    @inject(ProgressService) protected readonly progressService: ProgressService;
    @inject(LabelProvider) protected readonly labelProvider: LabelProvider;

    @inject(Git) protected readonly git: Git;
    @inject(GitRepositoryProvider) protected readonly repositoryProvider: GitRepositoryProvider;
    @inject(QuickInputService) @optional() protected readonly quickInputService: QuickInputService;
    @inject(MessageService) protected readonly messageService: MessageService;
    @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService;
    @inject(FileService) protected readonly fileService: FileService;

    async clone(url?: string, folder?: string, branch?: string): Promise<string | undefined> {
        return this.withProgress(async () => {
            if (!folder) {
                const roots = await this.workspaceService.roots;
                folder = roots[0].resource.toString();
            }

            if (url) {
                const repo = await this.git.clone(
                    url,
                    {
                        localUri: await this.buildDefaultProjectPath(folder, url),
                        branch: branch
                    });
                return repo.localUri;
            }

            this.quickInputService?.showQuickPick(
                [
                    new GitQuickPickItem(
                        nls.localize('theia/git/cloneQuickInputLabel', 'Please provide a Git repository location. Press \'Enter\' to confirm or \'Escape\' to cancel.')
                    )
                ],
                {
                    placeholder: nls.localize('vscode.git-base/bundle/Provide repository URL', 'Provide repository URL'),
                    onDidChangeValue: (quickPick: QuickPick<QuickPickItem>, filter: string) => this.query(quickPick, filter, folder)
                });
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private query(quickPick: any, filter: string, folder: any): void {
        quickPick.busy = true;
        const { git, buildDefaultProjectPath, gitErrorHandler, wrapWithProgress } = this;

        try {
            if (filter === undefined || filter.length === 0) {
                quickPick.items = [
                    new GitQuickPickItem(
                        nls.localize('theia/git/cloneQuickInputLabel', 'Please provide a Git repository location. Press \'Enter\' to confirm or \'Escape\' to cancel.')
                    )
                ];
            } else {
                quickPick.items = [
                    new GitQuickPickItem(
                        nls.localize(
                            'theia/git/cloneRepository',
                            'Clone the Git repository: {0}. Press \'Enter\' to confirm or \'Escape\' to cancel.',
                            filter
                        ),
                        wrapWithProgress(async () => {
                            try {
                                await git.clone(filter, { localUri: await buildDefaultProjectPath(folder, filter) });
                            } catch (error) {
                                gitErrorHandler.handleError(error);
                            }
                        }))
                ];
            }
        } catch (err) {
            quickPick.items = [new GitQuickPickItem('$(error) ' + nls.localizeByDefault('Error: {0}', err.message))];
            this.logger.error(err);
        } finally {
            quickPick.busy = false;
        }
    }

    private buildDefaultProjectPath = this.doBuildDefaultProjectPath.bind(this);
    private async doBuildDefaultProjectPath(folderPath: string, gitURI: string): Promise<string> {
        if (!(await this.fileService.exists(new URI(folderPath)))) {
            // user specifies its own project path, doesn't want us to guess it
            return folderPath;
        }
        const uriSplitted = gitURI.split('/');
        let projectPath = folderPath + '/' + (uriSplitted.pop() || uriSplitted.pop());
        if (projectPath.endsWith('.git')) {
            projectPath = projectPath.substring(0, projectPath.length - '.git'.length);
        }
        return projectPath;
    }

    async fetch(): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        return this.withProgress(async () => {
            const remotes = await this.getRemotes();
            const execute = async (item: GitQuickPickItem<Remote>) => {
                try {
                    await this.git.fetch(repository, { remote: item.ref!.name });
                } catch (error) {
                    this.gitErrorHandler.handleError(error);
                }
            };
            const items = remotes.map(remote => new GitQuickPickItem<Remote>(remote.name, execute, remote, remote.fetch));
            this.quickInputService?.showQuickPick(items, { placeholder: nls.localize('theia/git/fetchPickRemote', 'Pick a remote to fetch from:') });
        });
    }

    async fetchAll(): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        return this.withProgress(async () => {
            try {
                await this.git.exec(repository, ['fetch', '--all']);
            } catch (error) {
                this.gitErrorHandler.handleError(error);
            }
        });
    }

    async performDefaultGitAction(action: GitAction): Promise<void> {
        const remote = await this.getRemotes();
        const defaultRemote = remote[0]?.name;
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        return this.withProgress(async () => {
            try {
                if (action === GitAction.PULL) {
                    await this.git.pull(repository, { remote: defaultRemote });
                    this.logger.info(`Git Pull: successfully completed from ${defaultRemote}.`);
                } else if (action === GitAction.PUSH) {
                    await this.git.push(repository, { remote: defaultRemote, setUpstream: true });
                    this.logger.info(`Git Push: successfully completed to ${defaultRemote}.`);
                }
            } catch (error) {
                this.gitErrorHandler.handleError(error);
            }
        });
    }

    async push(): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        return this.withProgress(async () => {
            const [remotes, currentBranch] = await Promise.all([this.getRemotes(), this.getCurrentBranch()]);
            if (!currentBranch) {
                return;
            }
            const execute = async (item: GitQuickPickItem<Remote>) => {
                try {
                    await this.git.push(repository, { remote: item.label, setUpstream: true });
                } catch (error) {
                    this.gitErrorHandler.handleError(error);
                }
            };
            const items = remotes.map(remote => new GitQuickPickItem<Remote>(remote.name, execute, remote, remote.push));
            this.quickInputService?.showQuickPick(items, {
                placeholder: nls.localize(
                    'vscode.git/bundle/Pick a remote to publish the branch "{0}" to:', 'Pick a remote to publish the branch "{0}" to:',
                    currentBranch.name
                )
            });
        });
    }

    async pull(): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        return this.withProgress(async () => {
            const remotes = await this.getRemotes();
            const defaultRemote = remotes[0].name; // I wish I could use assignment destructuring here. (GH-413)
            const executeRemote = async (remoteItem: GitQuickPickItem<Remote>) => {
                // The first remote is the default.
                if (remoteItem.ref!.name === defaultRemote) {
                    try {
                        await this.git.pull(repository, { remote: remoteItem.label });
                    } catch (error) {
                        this.gitErrorHandler.handleError(error);
                    }
                } else {
                    // Otherwise we need to propose the branches from
                    const branches = await this.getBranches();
                    const executeBranch = async (branchItem: GitQuickPickItem<Branch>) => {
                        try {
                            await this.git.pull(repository, { remote: remoteItem.ref!.name, branch: branchItem.ref!.nameWithoutRemote });
                        } catch (error) {
                            this.gitErrorHandler.handleError(error);
                        }
                    };
                    const branchItems = branches
                        .filter(branch => branch.type === BranchType.Remote)
                        .filter(branch => (branch.name || '').startsWith(`${remoteItem.label}/`))
                        .map(branch => new GitQuickPickItem(branch.name, executeBranch, branch));

                    this.quickInputService?.showQuickPick(branchItems, {
                        placeholder: nls.localize('vscode.git/bundle/Pick a branch to pull from', 'Pick a branch to pull from')
                    });
                }
            };
            const remoteItems = remotes.map(remote => new GitQuickPickItem(remote.name, executeRemote, remote, remote.fetch));
            this.quickInputService?.showQuickPick(remoteItems, {
                placeholder: nls.localize('vscode.git/bundle/Pick a remote to pull the branch from', 'Pick a remote to pull the branch from')
            });
        });
    }

    async pushCurrentHistoryItemRef(): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        const historyProvider = this.repositoryProvider.selectedScmProvider?.historyProvider;
        const localBranch = historyProvider?.currentHistoryItemRef?.name;
        const remoteRefName = historyProvider?.currentHistoryItemRemoteRef?.name;
        if (!localBranch || !remoteRefName) {
            return;
        }
        const { remote, branch: remoteBranch } = parseRemoteRefName(remoteRefName);
        return this.withProgress(async () => {
            try {
                await this.git.push(repository, { remote, localBranch, remoteBranch });
            } catch (error) {
                this.gitErrorHandler.handleError(error);
            }
        });
    }

    async pullCurrentHistoryItemRef(): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        const remoteRefName = this.repositoryProvider.selectedScmProvider?.historyProvider?.currentHistoryItemRemoteRef?.name;
        if (!remoteRefName) {
            return;
        }
        const { remote, branch } = parseRemoteRefName(remoteRefName);
        return this.withProgress(async () => {
            try {
                await this.git.pull(repository, { remote, branch });
            } catch (error) {
                this.gitErrorHandler.handleError(error);
            }
        });
    }

    async merge(): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        return this.withProgress(async () => {
            const [branches, currentBranch] = await Promise.all([this.getBranches(), this.getCurrentBranch()]);
            const execute = async (item: GitQuickPickItem<Branch>) => {
                try {
                    await this.git.merge(repository, { branch: item.label });
                } catch (error) {
                    this.gitErrorHandler.handleError(error);
                }
            };
            const items = branches.map(branch => new GitQuickPickItem<Branch>(branch.name, execute, branch));
            const branchName = currentBranch ? `'${currentBranch.name}' ` : '';
            this.quickInputService?.showQuickPick(
                items,
                {
                    placeholder: nls.localize('theia/git/mergeQuickPickPlaceholder', 'Pick a branch to merge into the currently active {0} branch:', branchName)
                }
            );
        });
    }

    async checkout(): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        return this.withProgress(async () => {
            const [branches, currentBranch] = await Promise.all([this.getBranches(), this.getCurrentBranch()]);
            if (currentBranch) {
                // We do not show the current branch.
                const index = branches.findIndex(branch => branch && branch.name === currentBranch.name);
                branches.splice(index, 1);
            }
            const switchBranch = async (item: GitQuickPickItem<Branch>) => {
                try {
                    await this.git.checkout(repository, { branch: item.ref!.nameWithoutRemote });
                } catch (error) {
                    this.gitErrorHandler.handleError(error);
                }
            };

            const items = branches.map(branch => new GitQuickPickItem<Branch>(
                branch.type === BranchType.Remote ? branch.name : branch.nameWithoutRemote, switchBranch,
                branch,
                branch.type === BranchType.Remote
                    ? nls.localize('vscode.git/bundle/Remote branch at {0}', 'Remote branch at {0}', (branch.tip.sha.length > 8 ? ` ${branch.tip.sha.slice(0, 7)}` : ''))
                    : (branch.tip.sha.length > 8 ? ` ${branch.tip.sha.slice(0, 7)}` : '')));

            items.unshift(new GitQuickPickItem(nls.localize('vscode.git/bundle/{0} Create new branch...', '{0} Create new branch...', '$(plus)'), () => this.createBranch()));
            this.quickInputService?.showQuickPick(items, { placeholder: nls.localize('theia/git/checkoutSelectRef', 'Select a ref to checkout or create a new local branch:') });
        });
    }

    async checkoutHistoryItemRef(ref: ScmHistoryItemRef): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        return this.withProgress(async () => {
            try {
                if (ref.id.startsWith('refs/remotes/')) { // remote branch
                    const findTrackingBranches = async (upstreamBranch: string): Promise<string[]> => {
                        const result: string[] = [];
                        const { stdout } = await this.git.exec(repository, ['for-each-ref', '--format', '%(refname:short)%00%(upstream:short)', 'refs/heads'], { readOnly: true });
                        const lines = stdout.trim().split('\n');
                        for (const line of lines) {
                            const entry = line.trim();
                            if (entry) {
                                const [refName, upstream] = entry.split('\0');
                                if (upstream === upstreamBranch) {
                                    result.push(refName);
                                }
                            }
                        }
                        return result;
                    };

                    const trackingBranches = await findTrackingBranches(ref.name);
                    if (trackingBranches.length > 0) {
                        await this.git.checkout(repository, { branch: trackingBranches[0] });
                    } else {
                        await this.git.exec(repository, ['checkout', '-q', '--track', ref.name]);
                    }
                } else {
                    await this.git.checkout(repository, { branch: ref.name });
                }
            } catch (error) {
                this.gitErrorHandler.handleError(error);
            }
        });
    }

    async checkoutDetached(treeish: string): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        return this.withProgress(async () => {
            try {
                await this.git.exec(repository, ['checkout', '-q', '--detach', treeish]);
            } catch (error) {
                this.gitErrorHandler.handleError(error);
            }
        });
    }

    async createBranch(startPoint?: string): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        const branch = await this.quickInputService?.input({
            placeHolder: nls.localize('vscode.git/bundle/Branch name', 'Branch name'),
            prompt: nls.localize('vscode.git/bundle/Please provide a new branch name', 'Please provide a new branch name'),
            ignoreFocusLost: true
        });
        if (!branch) {
            return;
        }
        return this.withProgress(async () => {
            try {
                await this.git.branch(repository, { toCreate: branch, startPoint });
                await this.git.checkout(repository, { branch });
            } catch (error) {
                this.gitErrorHandler.handleError(error);
            }
        });
    }

    async createTag(ref?: string): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }

        const name = await this.quickInputService?.input({
            placeHolder: nls.localize('vscode.git/bundle/Tag name', 'Tag name'),
            prompt: nls.localize('vscode.git/bundle/Please provide a tag name', 'Please provide a tag name'),
            ignoreFocusLost: true
        });
        if (!name) {
            return;
        }

        const message = await this.quickInputService?.input({
            placeHolder: nls.localizeByDefault('Message'),
            prompt: nls.localize('vscode.git/bundle/Please provide a message to annotate the tag', 'Please provide a message to annotate the tag'),
            ignoreFocusLost: true
        });

        return this.withProgress(async () => {
            try {
                let args = ['tag'];
                if (message) {
                    args = [...args, '-a', name, '-m', message];
                } else {
                    args = [...args, name];
                }
                if (ref) {
                    args.push(ref);
                }
                await this.git.exec(repository, args);
            } catch (error) {
                this.gitErrorHandler.handleError(error);
            }
        });
    }

    async cherryPick(commitHash?: string): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        if (!commitHash) {
            commitHash = await this.quickInputService?.input({
                placeHolder: nls.localize('vscode.git/bundle/Commit Hash', 'Commit Hash'),
                prompt: nls.localize('vscode.git/bundle/Please provide the commit hash', 'Please provide the commit hash'),
                ignoreFocusLost: true
            });
        }
        if (!commitHash) {
            return;
        }
        return this.withProgress(async () => {
            try {
                await this.git.exec(repository, ['cherry-pick', commitHash]);
            } catch (error) {
                this.gitErrorHandler.handleError(error);
            }
        });
    }

    async deleteHistoryItemRef(ref: ScmHistoryItemRef): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }

        if (ref.id.startsWith('refs/heads/')) {
            if (ref.id === this.getHistoryProvider()?.currentHistoryItemRef?.id) {
                this.messageService.info(nls.localize('vscode.git/bundle/The active branch cannot be deleted.', 'The active branch cannot be deleted.'));
                return;
            }

            return this.deleteLocalBranch(ref.name, repository);
        }

        if (ref.id.startsWith('refs/remotes/')) {
            if (ref.id === this.getHistoryProvider()?.currentHistoryItemRemoteRef?.id) {
                this.messageService.info(nls.localize('vscode.git/bundle/The remote branch of the active branch cannot be deleted.',
                    'The remote branch of the active branch cannot be deleted.'));
                return;
            }

            const { remote, branch } = parseRemoteRefName(ref.name);
            return this.deleteRemoteBranch(remote, branch, repository);
        }

        if (ref.id.startsWith('refs/tags/')) {
            return this.deleteTag(ref.name, repository);
        }
    }

    protected async deleteLocalBranch(branchName: string, repository: Repository, force?: boolean): Promise<void> {
        try {
            await this.withProgress(async () => this.git.branch(repository, { toDelete: branchName, force }));
        } catch (error) {
            if (!force && error.message && /branch '.+' is not fully merged/.test(error.message)) {
                const confirmed = await new ConfirmDialog({
                    title: nls.localize('vscode.git/bundle/Delete Branch', 'Delete Branch'),
                    msg: nls.localize('vscode.git/bundle/The branch "{0}" is not fully merged. Delete anyway?',
                        'The branch "{0}" is not fully merged. Delete anyway?', branchName),
                    ok: Dialog.YES,
                    cancel: Dialog.NO
                }).open();
                if (confirmed) {
                    await this.deleteLocalBranch(branchName, repository, true);
                }
            } else {
                this.gitErrorHandler.handleError(error);
            }
        }
    }

    protected async deleteRemoteBranch(remoteName: string, branchName: string, repository: Repository): Promise<void> {
        return this.withProgress(async () => {
            try {
                await this.git.exec(repository, ['push', remoteName, '--delete', branchName]);
            } catch (error) {
                this.gitErrorHandler.handleError(error);
            }
        });
    }

    protected async deleteTag(tagName: string, repository: Repository): Promise<void> {
        return this.withProgress(async () => {
            try {
                await this.git.exec(repository, ['tag', '-d', tagName]);
            } catch (error) {
                this.gitErrorHandler.handleError(error);
            }
        });
    }

    async chooseTagsAndBranches(execFunc: (branchName: string, currentBranchName: string) => void, repository: Repository | undefined = this.getRepository()): Promise<void> {
        if (!repository) {
            return;
        }
        return this.withProgress(async () => {
            const [branches, tags, currentBranch] = await Promise.all([this.getBranches(repository), this.getTags(repository), this.getCurrentBranch(repository)]);
            const execute = async (item: GitQuickPickItem<Branch | Tag>) => {
                execFunc(item.ref!.name, currentBranch ? currentBranch.name : '');
            };
            const branchItems = branches.map(branch => new GitQuickPickItem<Branch>(branch.name, execute, branch));
            const branchName = currentBranch ? `'${currentBranch.name}' ` : '';
            const tagItems = tags.map(tag => new GitQuickPickItem<Tag>(tag.name, execute, tag));

            this.quickInputService?.showQuickPick([...branchItems, ...tagItems],
                { placeholder: nls.localize('theia/git/compareWithBranchOrTag', 'Pick a branch or tag to compare with the currently active {0} branch:', branchName) });
        });
    }

    async commitMessageForAmend(): Promise<string> {
        const repository = this.getRepository();
        if (!repository) {
            throw new Error(nls.localize('theia/git/noRepositoriesSelected', 'No repositories were selected.'));
        }
        return this.withProgress(async () => {
            const lastMessage = (await this.git.exec(repository, ['log', '--format=%B', '-n', '1'], { readOnly: true })).stdout.trim();
            if (lastMessage.length === 0) {
                throw new Error(nls.localize('theia/git/repositoryNotInitialized', 'Repository {0} is not yet initialized.', repository.localUri));
            }
            const message = lastMessage.replace(/[\r\n]+/g, ' ');
            const result = await new Promise<string>(async (resolve, reject) => {
                const getItems = (lookFor?: string) => {
                    const items = [];
                    if (!lookFor) {
                        const label = nls.localize('theia/git/amendReuseMessage', "To reuse the last commit message, press 'Enter' or 'Escape' to cancel.");
                        items.push(new GitQuickPickItem(label, () => resolve(lastMessage), label));
                    } else {
                        items.push(new GitQuickPickItem(
                            nls.localize('theia/git/amendRewrite', "Rewrite previous commit message. Press 'Enter' to confirm or 'Escape' to cancel."),
                            () => resolve(lookFor))
                        );
                    }
                    return items;
                };
                const updateItems = (quickPick: QuickPick<QuickPickItem>, filter: string) => {
                    quickPick.items = getItems(filter);
                };
                this.quickInputService?.showQuickPick(getItems(), { placeholder: message, onDidChangeValue: updateItems });
            });
            return result;
        });
    }

    async stash(): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        return this.withProgress(async () => {
            const doStash = this.wrapWithProgress(async (message: string) => {
                this.git.stash(repository, { message });
            });
            const getItems = (lookFor?: string) => {
                const items = [];
                if (lookFor === undefined || lookFor.length === 0) {
                    items.push(new GitQuickPickItem(nls.localize('theia/git/stashChanges', "Stash changes. Press 'Enter' to confirm or 'Escape' to cancel."), () => doStash('')));
                } else {
                    items.push(new GitQuickPickItem(
                        nls.localize('theia/git/stashChangesWithMessage', "Stash changes with message: {0}. Press 'Enter' to confirm or 'Escape' to cancel.", lookFor),
                        () => doStash(lookFor))
                    );
                }
                return items;
            };
            const updateItems = (quickPick: QuickPick<QuickPickItem>, filter: string) => {
                quickPick.items = getItems(filter);
            };
            this.quickInputService?.showQuickPick(getItems(), {
                placeholder: nls.localize('vscode.git/bundle/Stash message', 'Stash message'), onDidChangeValue: updateItems
            });
        });
    }

    protected async doStashAction(action: 'pop' | 'apply' | 'drop', text: string, getMessage?: () => Promise<string>): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        return this.withProgress(async () => {
            const list = await this.git.stash(repository, { action: 'list' });
            if (list) {
                const items = list.map(stash => new GitQuickPickItem<StashEntry>(stash.message,
                    this.wrapWithProgress(async () => {
                        try {
                            await this.git.stash(repository, { action, id: stash.id });
                            if (getMessage) {
                                this.messageService.info(await getMessage());
                            }
                        } catch (error) {
                            this.gitErrorHandler.handleError(error);
                        }
                    })));
                this.quickInputService?.showQuickPick(items, { placeholder: text });
            }
        });
    }

    async applyStash(): Promise<void> {
        this.doStashAction('apply', nls.localize('vscode.git/bundle/Pick a stash to apply', 'Pick a stash to apply'));
    }

    async popStash(): Promise<void> {
        this.doStashAction('pop', nls.localize('vscode.git/bundle/Pick a stash to pop', 'Pick a stash to pop'));
    }

    async dropStash(): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        this.doStashAction(
            'drop',
            nls.localize('vscode.git/bundle/Pick a stash to drop', 'Pick a stash to drop'),
            async () => nls.localize('theia/git/dropStashMessage', 'Stash successfully removed.')
        );
    }

    async applyLatestStash(): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        return this.withProgress(async () => {
            try {
                await this.git.stash(repository, {
                    action: 'apply'
                });
            } catch (error) {
                this.gitErrorHandler.handleError(error);
            }
        });
    }

    async popLatestStash(): Promise<void> {
        const repository = this.getRepository();
        if (!repository) {
            return;
        }
        return this.withProgress(async () => {
            try {
                await this.git.stash(repository, {
                    action: 'pop'
                });
            } catch (error) {
                this.gitErrorHandler.handleError(error);
            }
        });
    }

    async initRepository(): Promise<void> {
        const wsRoots = await this.workspaceService.roots;
        if (wsRoots && wsRoots.length > 1) {
            const items = wsRoots.map<GitQuickPickItem<URI>>(root => this.toRepositoryPathQuickOpenItem(root));
            this.quickInputService?.showQuickPick(items, {
                placeholder: nls.localize('vscode.git/bundle/Pick workspace folder to initialize git repo in', 'Pick workspace folder to initialize git repo in')
            });
        } else {
            const rootUri = wsRoots[0].resource;
            this.doInitRepository(rootUri.toString());
        }
    }

    private async doInitRepository(uri: string): Promise<void> {
        this.withProgress(async () => this.git.exec({ localUri: uri }, ['init']));
    }

    private toRepositoryPathQuickOpenItem(root: FileStat): GitQuickPickItem<URI> {
        const rootUri = root.resource;
        const execute = async (item: GitQuickPickItem<URI>) => {
            const wsRoot = item.ref!.toString();
            this.doInitRepository(wsRoot);
        };
        return new GitQuickPickItem<URI>(this.labelProvider.getName(rootUri), execute, rootUri, this.labelProvider.getLongName(rootUri.parent));
    }

    private getRepository(): Repository | undefined {
        return this.repositoryProvider.selectedRepository;
    }

    private getHistoryProvider(): ScmHistoryProvider | undefined {
        return this.repositoryProvider.selectedScmProvider?.historyProvider;
    }

    private async getRemotes(): Promise<Remote[]> {
        const repository = this.getRepository();
        if (!repository) {
            return [];
        }
        return this.withProgress(async () => {
            try {
                return await this.git.remote(repository, { verbose: true });
            } catch (error) {
                this.gitErrorHandler.handleError(error);
                return [];
            }
        });
    }

    private async getTags(repository: Repository | undefined = this.getRepository()): Promise<Tag[]> {
        if (!repository) {
            return [];
        }
        return this.withProgress(async () => {
            const result: Tag[] = [];
            const { stdout } = await this.git.exec(repository, ['tag', '--sort=-creatordate'], { readOnly: true });
            const lines = stdout.trim().split('\n');
            for (const line of lines) {
                const tag = line.trim();
                if (tag) {
                    result.push({ name: tag });
                }
            }
            return result;
        });
    }

    private async getBranches(repository: Repository | undefined = this.getRepository()): Promise<Branch[]> {
        if (!repository) {
            return [];
        }
        return this.withProgress(async () => {
            try {
                const [local, remote] = await Promise.all([
                    this.git.branch(repository, { type: 'local' }),
                    this.git.branch(repository, { type: 'remote' })
                ]);
                return [...local, ...remote];
            } catch (error) {
                this.gitErrorHandler.handleError(error);
                return [];
            }
        });
    }

    private async getCurrentBranch(repository: Repository | undefined = this.getRepository()): Promise<Branch | undefined> {
        if (!repository) {
            return undefined;
        }
        return this.withProgress(async () => {
            try {
                return await this.git.branch(repository, { type: 'current' });
            } catch (error) {
                this.gitErrorHandler.handleError(error);
                return undefined;
            }
        });
    }

    protected withProgress<In, Out>(fn: (...arg: In[]) => Promise<Out>): Promise<Out> {
        return this.progressService.withProgress('', 'scm', fn);
    }

    protected readonly wrapWithProgress = <In, Out>(fn: (...args: In[]) => Promise<Out>) => this.doWrapWithProgress(fn);
    protected doWrapWithProgress<In, Out>(fn: (...args: In[]) => Promise<Out>): (...args: In[]) => Promise<Out> {
        return (...args: In[]) => this.withProgress(() => fn(...args));
    }
}

class GitQuickPickItem<T> implements QuickPickItem {
    readonly execute?: () => void;
    constructor(
        public label: string,
        execute?: (item: QuickPickItem) => void,
        public readonly ref?: T,
        public description?: string,
        public alwaysShow = true,
        public sortByLabel = false) {
        this.execute = execute ? createExecFunction(execute, this) : undefined;
    }
}

function createExecFunction(f: (item: QuickPickItem) => void, item: QuickPickItem): () => void {
    return () => { f(item); };
}
