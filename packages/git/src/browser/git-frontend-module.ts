// *****************************************************************************
// Copyright (C) 2018 TypeFox and others.
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

import '../../src/browser/style/index.css';

import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import { CommandContribution, MenuContribution, ResourceResolver } from '@theia/core/lib/common';
import {
    WebSocketConnectionProvider,
    FrontendApplicationContribution,
} from '@theia/core/lib/browser';
import { TabBarToolbarContribution } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { Git, GitPath, GitWatcher, GitWatcherPath, GitWatcherServer, GitWatcherServerProxy, ReconnectingGitWatcherServer } from '../common/index.js';
import { GitContribution } from './git-contribution.js';
import { bindGitDiffModule } from './diff/git-diff-frontend-module.js';
import { bindGitHistoryModule } from './history/git-history-frontend-module.js';
import { GitResourceResolver } from './git-resource-resolver.js';
import { GitRepositoryProvider } from './git-repository-provider.js';
import { GitQuickOpenService } from './git-quick-open-service.js';
import { bindGitPreferences } from '../common/git-preferences.js';
import { bindDirtyDiff } from './dirty-diff/dirty-diff-module.js';
import { bindBlame } from './blame/blame-module.js';
import { GitRepositoryTracker } from './git-repository-tracker.js';
import { GitCommitMessageValidator } from './git-commit-message-validator.js';
import { GitSyncService } from './git-sync-service.js';
import { GitErrorHandler } from './git-error-handler.js';
import { GitScmProvider, GitScmProviderOptions } from './git-scm-provider.js';
import { ColorContribution } from '@theia/core/lib/browser/color-application-contribution';
import { ScmHistorySupport } from '@theia/scm-extra/lib/browser/history/scm-history-widget.js';
import { ScmHistoryProvider } from '@theia/scm-extra/lib/browser/history/index.js';
import { GitHistorySupport } from './history/git-history-support.js';
import { GitDecorationProvider } from './git-decoration-provider.js';
import { GitFileSystemProvider } from './git-file-system-provider.js';
import { GitFileServiceContribution } from './git-file-service-contribution.js';
import { FileServiceContribution } from '@theia/filesystem/lib/browser/file-service';
import { GitHistoryItemChangesParser, GitHistoryItemRefsParser, GitHistoryItemsParser, GitHistoryItemStatisticsParser, GitHistoryProvider } from './git-history-provider.js';

export default new ContainerModule(bind => {
    bindGitPreferences(bind);
    bindGitDiffModule(bind);
    bindGitHistoryModule(bind);
    bindDirtyDiff(bind);
    bindBlame(bind);
    bind(GitRepositoryTracker).toSelf().inSingletonScope();
    bind(GitWatcherServerProxy).toDynamicValue(context => WebSocketConnectionProvider.createProxy(context.container, GitWatcherPath)).inSingletonScope();
    bind(GitWatcherServer).to(ReconnectingGitWatcherServer).inSingletonScope();
    bind(GitWatcher).toSelf().inSingletonScope();
    bind(Git).toDynamicValue(context => WebSocketConnectionProvider.createProxy(context.container, GitPath)).inSingletonScope();

    bind(GitContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(GitContribution);
    bind(MenuContribution).toService(GitContribution);
    bind(FrontendApplicationContribution).toService(GitContribution);
    bind(TabBarToolbarContribution).toService(GitContribution);
    bind(ColorContribution).toService(GitContribution);

    bind(GitResourceResolver).toSelf().inSingletonScope();
    bind(ResourceResolver).toService(GitResourceResolver);

    bind(GitScmProvider.Factory).toFactory(createGitScmProviderFactory);
    bind(GitRepositoryProvider).toSelf().inSingletonScope();
    bind(GitDecorationProvider).toSelf().inSingletonScope();
    bind(GitQuickOpenService).toSelf().inSingletonScope();

    bind(GitCommitMessageValidator).toSelf().inSingletonScope();

    bind(GitSyncService).toSelf().inSingletonScope();
    bind(GitErrorHandler).toSelf().inSingletonScope();

    bind(GitFileSystemProvider).toSelf().inSingletonScope();
    bind(GitFileServiceContribution).toDynamicValue(ctx => new GitFileServiceContribution(ctx.container)).inSingletonScope();
    bind(FileServiceContribution).toService(GitFileServiceContribution);
});

export function createGitScmProviderFactory(ctx: interfaces.Context): GitScmProvider.Factory {
    return (options: GitScmProviderOptions) => {
        const container = ctx.container.createChild();
        container.bind(GitScmProviderOptions).toConstantValue(options);
        container.bind(GitScmProvider).toSelf().inSingletonScope();
        container.bind(GitHistoryItemRefsParser).toSelf().inSingletonScope();
        container.bind(GitHistoryItemStatisticsParser).toSelf().inSingletonScope();
        container.bind(GitHistoryItemsParser).toSelf().inSingletonScope();
        container.bind(GitHistoryItemChangesParser).toSelf().inSingletonScope();
        container.bind(GitHistoryProvider).toSelf().inSingletonScope();
        container.bind(GitHistorySupport).toSelf().inSingletonScope();
        container.bind(ScmHistorySupport).toService(GitHistorySupport);
        const provider = container.get(GitScmProvider);
        const historyProvider = container.get(GitHistoryProvider);
        provider.historyProvider = historyProvider;
        const historySupport = container.get(GitHistorySupport);
        (provider as ScmHistoryProvider).historySupport = historySupport;
        return provider;
    };
}
