import { promises } from 'fs'
import { FileSystem } from './FileSystem'

const { access, readFile, writeFile } = promises

export class NodeFileSystem implements FileSystem {
  public readonly basePath

  /**
   * Create new NodeFileSystem class instance.
   *
   * @param basePath The base path to use for reading and writing files. process.cwd() if not specified
   */
  public constructor(basePath?: string) {
    this.basePath = basePath ?? process.cwd()
  }

  public async exists(path: string) {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  public async write(path: string, data: string): Promise<void> {
    return writeFile(path, data, { encoding: 'utf-8' })
  }

  public async read(path: string): Promise<string> {
    return readFile(path, { encoding: 'utf-8' })
  }
}