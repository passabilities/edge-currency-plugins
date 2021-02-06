import Queue from 'p-queue'

export enum TaskPriority {
  LOW,
  MEDIUM,
  HIGH
}

export interface TaskPicker {
  addTask<T>(args: AddTaskArgs): Promise<T>
  addTasks(tasks: Task[], priority?: TaskPriority): Promise<void>
  waitForQueueSize(): Promise<void>
}

interface AddTaskArgs {
  task: Task
  priority?: TaskPriority
  wait?: boolean
}

export type Task = () => Promise<any>

export const makeTaskPicker = (): TaskPicker => {
  const queue = new Queue({
    concurrency: 10,
    autoStart: true
  })

  const waitForQueueSize = async (): Promise<void> => {
    return new Promise<void>((resolve) => {
      const checkQueueSize = () => {
        if (queue.size < 50) {
          queue.off('next', checkQueueSize)
          resolve()
        }
      }

      queue.on('next', checkQueueSize)
      checkQueueSize()
    })
  }

  const taskPicker: TaskPicker = {
    waitForQueueSize,

    async addTask<T>(args: AddTaskArgs): Promise<T> {
      await waitForQueueSize()

      const {
        task,
        priority = TaskPriority.MEDIUM,
        wait = false
      } = args
      const promise = queue.add(task, { priority })
      let response
      if (wait) response = await promise
      return response
    },

    async addTasks(tasks: Task[], priority?: TaskPriority): Promise<void> {
      for (const task of tasks) {
        await taskPicker.addTask({ task, priority })
      }
    }
  }
  return taskPicker
}
