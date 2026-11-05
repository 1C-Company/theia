declare function findGitRepositories(path: string, progressCb: (repositories: string[]) => void): Promise<string[]>;
export = findGitRepositories;
