import Queue from 'queue-promise'

export enum TaskPriority {
  HIGH,
  MEDIUM,
  LOW
}

export interface TaskPicker {
  addTask(args: AddTaskArgs): void
  addTasks(tasks: Task[], priority: TaskPriority): void
}

interface AddTaskArgs {
  task: Task
  priority: TaskPriority
}

type Task = () => Promise<any>

export const makeTaskPicker = async (): Promise<TaskPicker> => {
  const highQueue = new Queue({
    concurrent: 8,
    interval: 500,
    start: true
  })
  const mediumQueue = new Queue({
    concurrent: 4,
    interval: 1000,
    start: true
  })
  const lowQueue = new Queue({
    concurrent: 2,
    interval: 2000,
    start: true
  })

  const taskPicker: TaskPicker = {
    addTask(args: AddTaskArgs): void {
      let queue: Queue
      switch (args.priority) {
        case TaskPriority.HIGH:
          queue = highQueue
          break
        case TaskPriority.MEDIUM:
          queue = mediumQueue
          break
        case TaskPriority.LOW:
          queue = lowQueue
      }
      queue.add(args.task)
    },

    addTasks(tasks: Task[], priority: TaskPriority): void {
      for (const task of tasks) {
        taskPicker.addTask({
          task,
          priority
        })
      }
    }
  }
  return taskPicker
}
