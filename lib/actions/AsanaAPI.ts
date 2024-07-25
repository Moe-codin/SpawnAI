'use server'
import { Redis } from '@upstash/redis'
import asana from 'asana'
import { NextApiRequest, NextApiResponse } from 'next'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || ''
})

const asanaClient = asana.Client.create()

// Function to get user's workspace
async function getUserWorkspace(userId: string): Promise<string | null> {
  try {
    const workspaces = await asanaClient.workspaces.findAll();
    return workspaces.data[0]?.gid || null;
  } catch (error) {
    console.error('Error fetching user workspace:', error);
    return null;
  }
}

// Enhanced task creation function
export async function createAsanaTask(projectId: string, taskData: {
  name: string;
  notes?: string;
  due_on?: string;
  assignee?: string;
}) {
  try {
    const workspaceId = await getUserWorkspace('userId'); // Replace 'userId' with actual user ID
    if (!workspaceId) throw new Error('Workspace not found');

    const task = await asanaClient.tasks.create({
      ...taskData,
      projects: [projectId],
      workspace: workspaceId
    });
    return task;
  } catch (error) {
    console.error('Error creating Asana task:', error);
    return null;
  }
}

// Enhanced function to update a task
export async function updateAsanaTask(taskId: string, updates: asana.resources.Tasks.UpdateParams) {
  try {
    const updatedTask = await asanaClient.tasks.update(taskId, updates);
    return updatedTask;
  } catch (error) {
    console.error('Error updating Asana task:', error);
    return null;
  }
}

// Function to delete a task
export async function deleteAsanaTask(taskId: string) {
  try {
    await asanaClient.tasks.delete(taskId);
    return true;
  } catch (error) {
    console.error('Error deleting Asana task:', error);
    return false;
  }
}

// Enhanced function to get tasks by project and status
export async function getTasksByProjectAndStatus(projectId: string, status?: string) {
  try {
    const tasks = await asanaClient.tasks.findByProject(projectId, {
      opt_fields: 'name,completed,completed_at,due_on,notes,assignee.name,created_at,modified_at,tags.name'
    });
    return tasks.data.filter(task => {
      if (!status) return true;
      switch (status.toLowerCase()) {
        case 'pending':
          return !task.completed;
        case 'completed':
          return task.completed;
        case 'due_soon':
          const dueDate = task.due_on ? new Date(task.due_on) : null;
          const today = new Date();
          const threeDaysFromNow = new Date(today.setDate(today.getDate() + 3));
          return dueDate && dueDate <= threeDaysFromNow && !task.completed;
        case 'overdue':
          return task.due_on && new Date(task.due_on) < new Date() && !task.completed;
        case 'no_due_date':
          return !task.due_on && !task.completed;
        case 'recently_completed':
          const completedAt = task.completed_at ? new Date(task.completed_at) : null;
          const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          return completedAt && completedAt > oneWeekAgo;
        default:
          return true;
      }
    });
  } catch (error) {
    console.error('Error fetching Asana tasks by project and status:', error);
    return [];
  }
}

export async function getAsanaProjects(workspaceId: string) {
  try {
    const projects = await asanaClient.projects.findByWorkspace(workspaceId);
    return projects.data;
  } catch (error) {
    console.error('Error fetching Asana projects:', error);
    return [];
  }
}

export async function getAsanaProjectByName(workspaceId: string, projectName: string) {
  try {
    const projects = await asanaClient.projects.findByWorkspace(workspaceId);
    return projects.data.find(project => project.name.toLowerCase() === projectName.toLowerCase());
  } catch (error) {
    console.error('Error fetching Asana project by name:', error);
    return null;
  }
}

export async function handleChatMessage(message: string, userId: string = 'anonymous') {
  const accessToken = await redis.get(`asana_access_token_${userId}`);
  if (!accessToken) {
    return `Please connect your Asana account by typing "connect Asana".`;
  }

  asanaClient.useAccessToken(accessToken as string);
  const workspaceId = await getUserWorkspace(userId);

  if (!workspaceId) {
    return "Unable to determine your Asana workspace. Please check your account settings.";
  }

  if (message.toLowerCase() === 'connect asana') {
    const authUrl = `https://app.asana.com/-/oauth_authorize?client_id=${process.env.ASANA_CLIENT_ID}&redirect_uri=${encodeURIComponent(`${process.env.NEXT_PUBLIC_BASE_URL}/api/asana/callback`)}&response_type=code&state=${userId}`;
    return `Please click this link to connect your Asana account: ${authUrl}`;
  }

  if (message.startsWith('create task')) {
    const [_, projectName, ...taskDetails] = message.split(' in ');
    const project = await getAsanaProjectByName(workspaceId, projectName);
    if (!project) return `Project "${projectName}" not found.`;
    
    const [name, notes, dueOn, assignee] = taskDetails.join(' ').split(' | ');
    const task = await createAsanaTask(project.gid, { name, notes, due_on: dueOn, assignee });
    return task ? `Task "${name}" created successfully in project "${projectName}".` : 'Failed to create task.';
  }

  if (message.startsWith('update task')) {
    const [_, taskId, ...updates] = message.split(' ');
    const updateObj = Object.fromEntries(updates.map(update => update.split('=')));
    const updatedTask = await updateAsanaTask(taskId, updateObj);
    return updatedTask ? `Task ${taskId} updated successfully.` : 'Failed to update task.';
  }

  if (message.startsWith('delete task')) {
    const [_, taskId] = message.split(' ');
    const deleted = await deleteAsanaTask(taskId);
    return deleted ? `Task ${taskId} deleted successfully.` : 'Failed to delete task.';
  }

  if (message.startsWith('get project tasks')) {
    const [_, projectName, status] = message.split(' in ');
    const project = await getAsanaProjectByName(workspaceId, projectName);
    if (project) {
      const tasks = await getTasksByProjectAndStatus(project.gid, status);
      return `Found ${tasks.length} ${status || ''} tasks in project "${projectName}":\n${tasks.map(t => 
        `- ${t.name} (${t.completed ? 'Completed' : 'Pending'})${t.due_on ? ` Due: ${t.due_on}` : ''}${t.assignee ? ` Assignee: ${t.assignee.name}` : ''}`
      ).join('\n')}`;
    } else {
      return `Project "${projectName}" not found.`;
    }
  }

  return "I'm sorry, I didn't understand that command. Please try again.";
}

export async function handleOAuthCallback(code: string, state: string) {
  try {
    const tokenResponse = await fetch('https://app.asana.com/-/oauth_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.ASANA_CLIENT_ID || '',
        client_secret: process.env.ASANA_CLIENT_SECRET || '',
        redirect_uri: `${process.env.NEXT_PUBLIC_BASE_URL}/api/asana/callback`,
        code,
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error('Failed to fetch access token');
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    await redis.set(`asana_access_token_${state}`, accessToken);
    return true;
  } catch (error) {
    console.error('Error during OAuth callback:', error);
    return false;
  }
}